import { isDefaultOrder, sanitizeSortLevels, type SortLevel } from './message-list-order';

// The Sort menu of the list header (webmail components/email/mail-list-menus.tsx,
// e3f1ccce7). It writes the "Message list order" setting, so Settings agrees.
// The app keeps oldest/newest in its own `mailSortAscending` switch (the
// header button flipped it), so Newest and Oldest set that and clear the order.

export type SortChoiceKey = 'newest' | 'oldest' | 'unread' | 'starred' | 'sender' | 'subject' | 'largest';

export const SORT_CHOICES: ReadonlyArray<{ key: SortChoiceKey; levels: SortLevel[]; ascending: boolean }> = [
  { key: 'newest', levels: [], ascending: false },
  { key: 'oldest', levels: [], ascending: true },
  { key: 'unread', levels: [{ criterion: 'unread', direction: 'desc' }], ascending: false },
  { key: 'starred', levels: [{ criterion: 'starred', direction: 'desc' }], ascending: false },
  { key: 'sender', levels: [{ criterion: 'from', direction: 'asc' }], ascending: false },
  { key: 'subject', levels: [{ criterion: 'subject', direction: 'asc' }], ascending: false },
  { key: 'largest', levels: [{ criterion: 'size', direction: 'desc' }], ascending: false },
];

/** The choice the open folder's order is, or null for an order only Settings makes. */
export function sortChoiceFor(levels: SortLevel[], ascending: boolean): SortChoiceKey | null {
  const last = levels[levels.length - 1];
  const core = levels.length > 1 && last.criterion === 'receivedAt' && last.direction === 'desc'
    ? levels.slice(0, -1)
    : levels;
  if (isDefaultOrder(core)) return ascending ? 'oldest' : 'newest';
  if (core.length !== 1 || ascending) return null;
  const match = SORT_CHOICES.find((choice) =>
    choice.levels.length === 1
    && choice.levels[0].criterion === core[0].criterion
    && choice.levels[0].direction === core[0].direction);
  return match?.key ?? null;
}

export interface SortChoiceChanges {
  messageListOrder: SortLevel[];
  mailSortAscending: boolean;
  /** Set when the order only applied to the Inbox and was picked in another folder. */
  messageListOrderScope?: 'all';
}

/**
 * The settings a pick writes. Picked outside the Inbox while the order applies
 * to the Inbox only, it applies to all folders, or the pick would do nothing.
 */
export function sortChoiceChanges(
  key: SortChoiceKey,
  scope: 'inbox' | 'all',
  folderRole: string | null | undefined,
): SortChoiceChanges | null {
  const choice = SORT_CHOICES.find((c) => c.key === key);
  if (!choice) return null;
  return {
    messageListOrder: sanitizeSortLevels(choice.levels.map((level) => ({ ...level }))),
    mailSortAscending: choice.ascending,
    ...(scope === 'inbox' && folderRole !== 'inbox' && choice.levels.length > 0 ? { messageListOrderScope: 'all' as const } : {}),
  };
}
