import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../api/jmap-client', () => ({ jmapClient: { username: 'me@x.com' } }));
vi.mock('../../stores/account-store', () => ({
  useAccountStore: { getState: () => ({ getActiveAccount: () => null, activeAccountId: null }) },
}));
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: { getState: () => ({ identities: [] }) },
}));
vi.mock('../email-detail-cache', () => ({
  peekThread: vi.fn(), loadThread: vi.fn(), peekDetail: vi.fn(), loadDetails: vi.fn(),
}));

import type { Email, Mailbox } from '../../api/types';
import type { ThreadView } from '../email-detail-cache';
import { answersMessage, draftFoldersOf, isResumableDraft, pickReplyDraft, withReplyAllRecipients } from '../reply-drafts';
import { heldReplyDraftContext, prepareReplyDrafts, type ReplyDraftDeps } from '../reply-draft-resume';

const original = {
  id: 'm1',
  threadId: 't1',
  messageId: ['abc@x.com'],
  keywords: { $seen: true },
  mailboxIds: { inbox: true },
  from: [{ name: 'Ann', email: 'ann@x.com' }],
  to: [{ email: 'me@x.com' }, { email: 'bob@x.com' }],
  cc: [{ email: 'carol@x.com' }],
} as unknown as Email;

const draft = (id: string, inReplyTo: string[] | null, receivedAt: string, isDraft = true) =>
  ({ id, inReplyTo, receivedAt, keywords: isDraft ? { $draft: true } : {} }) as unknown as Email;

const box = (id: string, role: string | null, extra: Partial<Mailbox> = {}) => ({ id, name: id, role, ...extra }) as Mailbox;
const MAILBOXES = [box('inbox', 'inbox'), box('drafts', 'drafts'), box('trash', 'trash'), box('junk', 'junk')];

describe('reply drafts', () => {
  it('knows a draft that answers the message by its In-Reply-To', () => {
    expect(answersMessage(draft('d', ['<abc@x.com>'], ''), original)).toBe(true);
    expect(answersMessage(draft('d', ['other@x.com'], ''), original)).toBe(false);
    expect(answersMessage(draft('d', ['abc@x.com'], '', false), original)).toBe(false);
    expect(answersMessage(draft('d', ['abc@x.com'], ''), { messageId: null } as Email)).toBe(false);
  });

  it('picks the newest draft that answers the message', () => {
    const drafts = [
      draft('old', ['abc@x.com'], '2026-11-01T10:00:00Z'),
      draft('new', ['abc@x.com'], '2026-11-02T10:00:00Z'),
      draft('other', ['zzz@x.com'], '2026-11-03T10:00:00Z'),
    ];
    expect(pickReplyDraft(drafts, original)?.id).toBe('new');
    expect(pickReplyDraft([drafts[2]], original)).toBeNull();
  });

  it('adds the other recipients for reply all, each once and without me', () => {
    const merged = withReplyAllRecipients(
      { id: 'd', to: [{ email: 'ann@x.com' }], cc: [] },
      { from: original.from!, to: original.to!, cc: original.cc! },
      ['me@x.com'],
    );
    expect(merged.to?.map((r) => r.email)).toEqual(['ann@x.com', 'bob@x.com']);
    expect(merged.cc?.map((r) => r.email)).toEqual(['carol@x.com']);
  });
});

// A reply draft moved to Trash keeps its $draft keyword and stays in the
// conversation; it must not be the one that reopens.
describe('which drafts Reply may reopen', () => {
  const inBox = (mailbox: string) => ({ keywords: { $draft: true }, mailboxIds: { [mailbox]: true } });

  it('keeps only the drafts in the Drafts folder, not one moved to Trash or Junk', () => {
    const folders = draftFoldersOf(MAILBOXES);
    expect(isResumableDraft(inBox('drafts'), folders)).toBe(true);
    expect(isResumableDraft(inBox('trash'), folders)).toBe(false);
    expect(isResumableDraft(inBox('junk'), folders)).toBe(false);
    expect(isResumableDraft({ keywords: {}, mailboxIds: { drafts: true } }, folders)).toBe(false);
  });

  it('keeps every draft outside Trash and Junk in an account without a Drafts folder', () => {
    const folders = draftFoldersOf([box('trash', 'trash'), box('spam', 'spam')]);
    expect(isResumableDraft(inBox('inbox'), folders)).toBe(true);
    expect(isResumableDraft(inBox('trash'), folders)).toBe(false);
    expect(isResumableDraft(inBox('spam'), folders)).toBe(false);
  });

  it('matches a shared account\'s folders on their raw ids', () => {
    const folders = draftFoldersOf([box('acc2:d', 'drafts', { originalId: 'd', isShared: true, accountId: 'acc2' })]);
    expect(isResumableDraft(inBox('d'), folders)).toBe(true);
  });
});

/** The reader's cache, held in memory, with the server behind it. */
function fakeCache(server: { members: Email[]; failThread?: boolean }) {
  const threads = new Map<string, ThreadView>();
  const details = new Map<string, Email>();
  let releaseThread: (() => void) | null = null;
  const deps: ReplyDraftDeps = {
    peekThread: (id) => threads.get(id),
    loadThread: vi.fn((id: string) => new Promise<ThreadView>((resolve, reject) => {
      releaseThread = () => {
        if (server.failThread) return reject(new Error('offline'));
        const view = { ids: server.members.map((e) => e.id), headers: new Map(server.members.map((e) => [e.id, e])) };
        threads.set(id, view);
        resolve(view);
      };
    })),
    peekDetail: (id) => details.get(id),
    loadDetails: vi.fn(async (ids: string[]) => {
      for (const id of ids) details.set(id, fullDraft(id));
      return new Map(ids.map((id) => [id, details.get(id)!]));
    }),
    ownEmails: () => ['me@x.com'],
  };
  return { deps, threads, details, release: () => releaseThread?.() };
}

const header = (id: string, mailbox: string) => ({
  id, threadId: 't1', keywords: { $draft: true }, mailboxIds: { [mailbox]: true }, receivedAt: '2026-11-02T10:00:00Z',
}) as unknown as Email;
const fullDraft = (id: string) => ({
  ...header(id, 'drafts'), subject: 'Re: hi', to: [{ email: 'ann@x.com' }], inReplyTo: ['abc@x.com'],
}) as unknown as Email;

describe('Reply on a message with a saved reply', () => {
  it('opens a new reply at once while the conversation is still being read', async () => {
    const { deps, release } = fakeCache({ members: [original, header('d1', 'drafts')] });
    void prepareReplyDrafts('t1', 'acc', MAILBOXES, deps);
    await Promise.resolve();

    // Reply is tapped before the lookup is back: it answers right away,
    // with nothing to wait for, and the caller starts a new reply.
    const result = heldReplyDraftContext('reply', original, 'acc', MAILBOXES, deps);
    expect(result).toBeNull();
    release();
  });

  it('opens the saved reply once the lookup has finished', async () => {
    const { deps, release } = fakeCache({ members: [original, header('d1', 'drafts')] });
    const prepared = prepareReplyDrafts('t1', 'acc', MAILBOXES, deps);
    release();
    await prepared;
    expect(deps.loadThread).toHaveBeenCalledWith('t1', 'acc');
    expect(deps.loadDetails).toHaveBeenCalledWith(['d1'], 'acc');

    const ctx = heldReplyDraftContext('reply', original, 'acc', MAILBOXES, deps);
    expect(ctx?.id).toBe('d1');
    expect(ctx?.jmapAccountId).toBe('acc');
    expect(ctx?.to?.map((r) => r.email)).toEqual(['ann@x.com']);

    const all = heldReplyDraftContext('replyAll', original, 'acc', MAILBOXES, deps);
    expect(all?.to?.map((r) => r.email)).toEqual(['ann@x.com', 'bob@x.com']);
    expect(all?.cc?.map((r) => r.email)).toEqual(['carol@x.com']);

    // A held draft is not read again.
    const again = prepareReplyDrafts('t1', 'acc', MAILBOXES, deps);
    release();
    await again;
    expect(deps.loadDetails).toHaveBeenCalledTimes(1);
  });

  it('starts a new reply when the saved one was moved to Trash', async () => {
    const { deps, release } = fakeCache({ members: [original, header('d1', 'trash')] });
    const prepared = prepareReplyDrafts('t1', 'acc', MAILBOXES, deps);
    release();
    await prepared;
    expect(deps.loadDetails).not.toHaveBeenCalled();
    expect(heldReplyDraftContext('reply', original, 'acc', MAILBOXES, deps)).toBeNull();
  });

  it('starts a new reply once a discarded draft has left the conversation', async () => {
    const server = { members: [original, header('d1', 'drafts')] };
    const { deps, release } = fakeCache(server);
    let prepared = prepareReplyDrafts('t1', 'acc', MAILBOXES, deps);
    release();
    await prepared;
    expect(heldReplyDraftContext('reply', original, 'acc', MAILBOXES, deps)?.id).toBe('d1');

    // Discarding reads the conversation again; the draft's copy stays held.
    server.members = [original];
    prepared = prepareReplyDrafts('t1', 'acc', MAILBOXES, deps);
    release();
    await prepared;
    expect(heldReplyDraftContext('reply', original, 'acc', MAILBOXES, deps)).toBeNull();
  });

  it('starts a new reply when the lookup fails', async () => {
    const { deps, release } = fakeCache({ members: [], failThread: true });
    const prepared = prepareReplyDrafts('t1', 'acc', MAILBOXES, deps);
    release();
    await expect(prepared).resolves.toBeUndefined();
    expect(heldReplyDraftContext('reply', original, 'acc', MAILBOXES, deps)).toBeNull();
  });

  // The reader has no RN renderer in the suite: checked on its source.
  it('the reader reads the saved replies as the message opens and Reply never waits for them', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailThreadScreen.tsx'), 'utf8');
    const nav = source.slice(source.indexOf('const navigateCompose'), source.indexOf('replyComposeParams(mode, source'));
    expect(nav).not.toMatch(/\basync\b|\bawait\b/);
    expect(nav).toMatch(/if \(mode !== 'forward' && !typed\?\.trim\(\)\) \{\r?\n\s+const draft = heldReplyDraftContext\(mode, source, ownerAccountId, scopedMailboxes\);/);
    expect(nav).toMatch(/navigation\.navigate\('Compose', \{ draft \}\);\r?\n\s+return;/);
    // Started when the message opens, before any Reply.
    expect(source).toMatch(/React\.useEffect\(\(\) => \{\r?\n\s+if \(replyThreadId\) void prepareReplyDrafts\(replyThreadId, ownerAccountId, scopedMailboxes\);/);
    // The toolbar's and the cards' Reply, Reply all and the quick reply's
    // "more options" all go through navigateCompose.
    expect(source).toMatch(/onPress: \(\) => navigateCompose\('reply'\)/);
    expect(source).toMatch(/onPress: \(\) => navigateCompose\('replyAll'\)/);
    expect(source).toMatch(/onReply=\{navigateCompose\}/);
    expect(source).toMatch(/onMoreOptions=\{\(draft\) => onReply\('reply', newest, draft\)\}/);
  });
});
