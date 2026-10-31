import type { Email, Mailbox } from '../api/types';

/** Whether a list row sits in `mailbox` (a shared folder's id carries its account). */
function rowInMailbox(row: Pick<Email, 'mailboxIds' | 'jmapAccountId'>, mailbox: Mailbox): boolean {
  if (row.jmapAccountId && mailbox.accountId && row.jmapAccountId !== mailbox.accountId) return false;
  const raw = mailbox.originalId ?? mailbox.id;
  return !!row.mailboxIds?.[raw] || !!row.mailboxIds?.[mailbox.id];
}

/**
 * The folder the move sheet marks as current (checked, not pickable). The
 * open folder only when every message being moved is already in it: a search
 * across folders lists messages from other folders while the open one stays
 * selected, and those can be moved into it (webmail lib/move-targets.ts,
 * #1452). Null when it can be picked.
 */
export function moveSheetCurrentId(
  mailboxes: readonly Mailbox[],
  currentMailboxId: string | null,
  rows: ReadonlyArray<Pick<Email, 'mailboxIds' | 'jmapAccountId'>>,
): string | null {
  if (!currentMailboxId) return null;
  const current = mailboxes.find((m) => m.id === currentMailboxId);
  if (!current || rows.length === 0) return currentMailboxId;
  return rows.every((row) => rowInMailbox(row, current)) ? currentMailboxId : null;
}
