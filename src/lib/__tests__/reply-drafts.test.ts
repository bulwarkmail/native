import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../api/email', () => ({ getThreadDrafts: vi.fn(), getFullEmail: vi.fn() }));
vi.mock('../../api/jmap-client', () => ({ jmapClient: { username: 'me@x.com' } }));
vi.mock('../../stores/account-store', () => ({
  useAccountStore: { getState: () => ({ getActiveAccount: () => null, activeAccountId: null }) },
}));
vi.mock('../identity-cache', () => ({ readCachedIdentities: async () => [] }));

import type { Email } from '../../api/types';
import { answersMessage, pickReplyDraft, withReplyAllRecipients } from '../reply-drafts';
import { findReplyDraftContext } from '../reply-draft-resume';

const original = {
  id: 'm1',
  threadId: 't1',
  messageId: ['abc@x.com'],
  from: [{ name: 'Ann', email: 'ann@x.com' }],
  to: [{ email: 'me@x.com' }, { email: 'bob@x.com' }],
  cc: [{ email: 'carol@x.com' }],
} as unknown as Email;

const draft = (id: string, inReplyTo: string[] | null, receivedAt: string, isDraft = true) =>
  ({ id, inReplyTo, receivedAt, keywords: isDraft ? { $draft: true } : {} }) as unknown as Email;

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

  it('opens the saved reply instead of a new one', async () => {
    const getThreadDrafts = vi.fn(async () => [draft('d1', ['abc@x.com'], '2026-11-02T10:00:00Z')]);
    const getFullEmail = vi.fn(async (id: string) => ({
      id, subject: 'Re: hi', to: [{ email: 'ann@x.com' }], inReplyTo: ['abc@x.com'], keywords: { $draft: true },
    }) as unknown as Email);
    const deps = { getThreadDrafts, getFullEmail, ownEmails: async () => ['me@x.com'] };

    const ctx = await findReplyDraftContext('reply', original, 'acc', deps);
    expect(getThreadDrafts).toHaveBeenCalledWith('t1', 'acc');
    expect(ctx?.id).toBe('d1');
    expect(ctx?.jmapAccountId).toBe('acc');
    expect(ctx?.to?.map((r) => r.email)).toEqual(['ann@x.com']);

    const all = await findReplyDraftContext('replyAll', original, 'acc', deps);
    expect(all?.to?.map((r) => r.email)).toEqual(['ann@x.com', 'bob@x.com']);
    expect(all?.cc?.map((r) => r.email)).toEqual(['carol@x.com']);
  });

  // The reader has no RN renderer in the suite: checked on its source.
  it('the reader looks for the saved reply before it starts a new one', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailThreadScreen.tsx'), 'utf8');
    const nav = source.slice(source.indexOf('const navigateCompose'), source.indexOf('replyComposeParams(mode, source'));
    expect(nav).toMatch(/if \(mode !== 'forward' && !typed\?\.trim\(\)\) \{\r?\n\s+const draft = await findReplyDraftContext\(mode, source, ownerAccountId\);/);
    expect(nav).toMatch(/navigation\.navigate\('Compose', \{ draft \}\);\r?\n\s+return;/);
  });

  it('starts a new reply when there is no saved one or the lookup fails', async () => {
    const none = { getThreadDrafts: async () => [], getFullEmail: vi.fn(), ownEmails: async () => [] };
    expect(await findReplyDraftContext('reply', original, undefined, none)).toBeNull();
    const failing = { getThreadDrafts: async () => { throw new Error('offline'); }, getFullEmail: vi.fn(), ownEmails: async () => [] };
    expect(await findReplyDraftContext('reply', original, undefined, failing)).toBeNull();
  });
});
