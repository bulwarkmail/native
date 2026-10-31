import type { Mailbox } from '../../api/types';
import type { RecentCheck } from './recovery-store';

/**
 * The account's own Trash, the one whose archive Settings > Recover deleted
 * items shows (webmail components/email/trash-recovery-link.tsx). A shared
 * or group Trash has an archive of its own that the page doesn't show.
 * `accountId` is the JMAP account the page is for (useDeletedItemsRecovery).
 */
export function isOwnTrash(mailbox: Mailbox | undefined, accountId: string | null): boolean {
  return !!accountId && mailbox?.role === 'trash' && !mailbox.isShared
    && (!mailbox.accountId || mailbox.accountId === accountId);
}

/**
 * Whether the Trash header leads to Recover deleted items: the server offers
 * it for this account and its archive holds a message inside the days
 * window, looked up for that same window, so the link never opens an empty
 * page.
 */
export function trashRecoveryLinkVisible(options: {
  available: boolean;
  ownTrash: boolean;
  recent: RecentCheck | undefined;
  days: number;
}): boolean {
  const { available, ownTrash, recent, days } = options;
  return available && ownTrash && !!recent?.has && recent.days === days;
}
