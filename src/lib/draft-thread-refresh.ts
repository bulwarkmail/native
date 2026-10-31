// A reply draft only showed in its conversation after a pull-to-refresh. The
// draft lands in Drafts, so the mailbox list on screen gets no change for it,
// and the conversation held for the reader still matched the account's Email
// state as last read. After each save the composer has the conversation read
// again, which the reader and the list's conversation size pick up.

import { peekDetail, peekRow, refreshThread } from './email-detail-cache';
import { useEmailStore } from '../stores/email-store';

export interface DraftThread {
  threadId: string;
  /** The JMAP account the conversation is in (the reader's owner account). */
  accountId?: string;
}

/**
 * The conversation a draft belongs to: the one of the message it answers or
 * forwards, else the one of the draft being edited. Null when neither is held.
 */
export function draftThreadOf(ctx: {
  replyTo?: { originalEmailId?: string; jmapAccountId?: string };
  draft?: { id: string; jmapAccountId?: string };
}): DraftThread | null {
  const find = (id: string, accountId?: string): DraftThread | null => {
    const threadId = peekDetail(id, accountId)?.threadId ?? peekRow(id, accountId)?.threadId;
    return threadId ? { threadId, accountId } : null;
  };
  if (ctx.replyTo?.originalEmailId) {
    const found = find(ctx.replyTo.originalEmailId, ctx.replyTo.jmapAccountId);
    if (found) return found;
  }
  if (ctx.draft?.id) return find(ctx.draft.id, ctx.draft.jmapAccountId);
  return null;
}

/** Read the conversation again and update the list's count for it. */
export async function refreshDraftThread(target: DraftThread): Promise<void> {
  const view = await refreshThread(target.threadId, target.accountId);
  if (!view) return;
  const counts = useEmailStore.getState().threadCounts;
  const keys = [target.threadId, target.accountId ? `${target.accountId}:${target.threadId}` : null]
    .filter((k): k is string => !!k && counts[k] !== undefined && counts[k] !== view.ids.length);
  if (keys.length === 0) return;
  const next = { ...counts };
  for (const k of keys) next[k] = view.ids.length;
  useEmailStore.setState({ threadCounts: next });
}
