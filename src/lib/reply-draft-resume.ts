// Reply on a message that already has a reply draft opens that draft
// (webmail mail-app resumeReplyDraft). As in the webmail, the drafts are read
// when the message opens, from the conversation the reader reads anyway, and
// Reply goes by what is held by then: it never waits for the network. When
// the draft isn't held yet, Reply starts a new message at once.

import type { Email, Mailbox } from '../api/types';
import type { ComposeDraftContext } from '../navigation/types';
import { jmapClient } from '../api/jmap-client';
import { useAccountStore } from '../stores/account-store';
import { useSettingsStore } from '../stores/settings-store';
import { draftContextFromEmail } from './draft-context';
import { loadDetails, loadThread, peekDetail, peekThread, type ThreadView } from './email-detail-cache';
import { draftFoldersOf, isResumableDraft, pickReplyDraft, withReplyAllRecipients } from './reply-drafts';

export interface ReplyDraftDeps {
  peekThread: (threadId: string, accountId?: string) => ThreadView | undefined;
  loadThread: (threadId: string, accountId?: string) => Promise<ThreadView>;
  peekDetail: (id: string, accountId?: string) => Email | undefined;
  loadDetails: (ids: string[], accountId?: string) => Promise<Map<string, Email>>;
  ownEmails: () => string[];
}

function ownEmails(): string[] {
  const active = useAccountStore.getState().getActiveAccount();
  const out = new Set<string>();
  for (const e of [active?.email, active?.username, jmapClient.username]) {
    if (e && e.includes('@')) out.add(e);
  }
  for (const i of useSettingsStore.getState().identities ?? []) {
    if (i.email) out.add(i.email);
  }
  return Array.from(out);
}

const defaultDeps: ReplyDraftDeps = { peekThread, loadThread, peekDetail, loadDetails, ownEmails };

/**
 * The held conversation's drafts that Reply may reopen (in the Drafts
 * folder), oldest first. A draft discarded or moved away has left the
 * conversation or its folder once the conversation was read again.
 */
export function resumableReplyDraftIds(
  threadId: string,
  accountId: string | undefined,
  mailboxes: readonly Mailbox[],
  deps: Pick<ReplyDraftDeps, 'peekThread' | 'peekDetail'> = defaultDeps,
): string[] {
  const view = deps.peekThread(threadId, accountId);
  if (!view) return [];
  const folders = draftFoldersOf(mailboxes);
  return view.ids.filter((id) => {
    const copy = view.headers.get(id) ?? deps.peekDetail(id, accountId);
    return !!copy && isResumableDraft(copy, folders);
  });
}

/**
 * Read what Reply needs to reopen a saved reply in this conversation: the
 * conversation and its drafts in full. Run when the message opens, in the
 * background; never throws.
 */
export async function prepareReplyDrafts(
  threadId: string,
  accountId: string | undefined,
  mailboxes: readonly Mailbox[],
  deps: ReplyDraftDeps = defaultDeps,
): Promise<void> {
  try {
    await deps.loadThread(threadId, accountId);
    // A message's body never changes, so a draft held once is held for good.
    const missing = resumableReplyDraftIds(threadId, accountId, mailboxes, deps)
      .filter((id) => !deps.peekDetail(id, accountId));
    if (missing.length > 0) await deps.loadDetails(missing, accountId);
  } catch {
    // Reply starts a new message.
  }
}

/**
 * The saved reply to `source` as composer params, when it is already held
 * (see prepareReplyDrafts), else null to start a new reply. Reply all adds
 * the message's other recipients to the draft's.
 */
export function heldReplyDraftContext(
  mode: 'reply' | 'replyAll',
  source: Email,
  accountId: string | undefined,
  mailboxes: readonly Mailbox[],
  deps: ReplyDraftDeps = defaultDeps,
): ComposeDraftContext | null {
  if (source.keywords?.$draft || !source.threadId || !source.messageId?.length) return null;
  const drafts = resumableReplyDraftIds(source.threadId, accountId, mailboxes, deps)
    .map((id) => deps.peekDetail(id, accountId))
    .filter((e): e is Email => !!e);
  const found = pickReplyDraft(drafts, source);
  if (!found) return null;
  const ctx = draftContextFromEmail(found, accountId);
  if (mode !== 'replyAll') return ctx;
  return withReplyAllRecipients(ctx, {
    from: source.from ?? undefined,
    replyToAddresses: source.replyTo ?? undefined,
    to: source.to ?? undefined,
    cc: source.cc ?? undefined,
  }, deps.ownEmails());
}
