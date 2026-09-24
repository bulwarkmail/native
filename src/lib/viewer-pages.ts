import type { Email } from '../api/types';

export interface ViewerPagesInput {
  /** The message the viewer opens on, and its thread. */
  emailId: string;
  threadId: string;
  /** Ids handed over by a list other than the open folder (unified inbox, contact activity). */
  emailIds?: string[];
  /** The store's loaded list: the open folder's rows. */
  list: Email[];
  /** Whether that list is the message's account: ids are only unique per account. */
  listIsMessageAccount: boolean;
  threading: boolean;
}

/**
 * The pages the viewer swipes through, worked out once when it opens. Following
 * the live list let new mail shift the page under the user while Star, Delete
 * and Archive still acted on the message they had opened (B5).
 *
 * A message opened from the open folder pages over that folder, collapsed to
 * one page per thread when threading is on (the opened message standing in for
 * its thread); one opened from another list pages over the ids that list handed
 * over; anything else (notification, deep link, a group message not in the
 * folder page) is a single page, so the pager never shows `pages[0]` while the
 * toolbar acts on the tapped message.
 */
export function viewerPages(input: ViewerPagesInput): Email[] {
  const { emailId, threadId, emailIds, threading } = input;
  // Another account's rows say nothing about this message, whatever their ids.
  const list = input.listIsMessageAccount ? input.list : [];
  if (emailIds && emailIds.length > 0) {
    const byId = new Map(list.map((e) => [e.id, e]));
    return emailIds.map((id) => byId.get(id) ?? ({ id, threadId } as Email));
  }
  const opened = list.find((e) => e.id === emailId);
  if (!opened) return [{ id: emailId, threadId } as Email];
  if (!threading) return [...list];
  const openedKey = opened.threadId || opened.id;
  const seen = new Set<string>();
  const out: Email[] = [];
  for (const e of list) {
    const key = e.threadId || e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key === openedKey ? opened : e);
  }
  return out;
}
