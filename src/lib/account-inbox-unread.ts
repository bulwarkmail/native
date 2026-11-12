// The Inbox unread count each account shows in the account switcher
// (webmail lib/account-inbox-unread.ts, 2a726c0f4).

import type { Mailbox } from '../api/types';

/** The unread of the account's own Inbox; undefined while its folders aren't loaded. */
export function inboxUnread(mailboxes: Mailbox[] | undefined): number | undefined {
  if (!mailboxes || mailboxes.length === 0) return undefined;
  const inbox = mailboxes.find((mailbox) => mailbox.role === 'inbox' && !mailbox.isShared);
  return inbox ? inbox.unreadEmails : undefined;
}

/**
 * The unread of `accountId`'s Inbox from what the app holds: the live folder
 * list for the account the email store shows, the cached one for the others.
 */
export function accountInboxUnread(
  accountId: string,
  shownAccountId: string | null,
  shownMailboxes: Mailbox[],
  snapshots: Record<string, { mailboxes: Mailbox[] } | undefined>,
): number | undefined {
  return inboxUnread(accountId === shownAccountId ? shownMailboxes : snapshots[accountId]?.mailboxes);
}
