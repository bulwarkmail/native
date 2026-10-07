import type { CrossView } from '../api/unified-inbox';

/**
 * Whether the drawer offers the unified mailbox (the "All inboxes" row and
 * the Unified section), following the webmail's rule (#843): only when the
 * unified views will hold more than the open account's own folders.
 *
 * - Cross-account on and a second account signed in: every account's mail.
 * - Group inboxes merged in and the account has one: own plus group mail.
 *
 * A second account alone is not enough: with cross-account off the views
 * cover only the active account, so "All inboxes" merely repeated Inbox.
 */
export function showUnifiedSection(opts: {
  accountCount: number;
  unifiedCrossAccount: boolean;
  includeGroupInUnified: boolean;
  hasSharedInbox: boolean;
}): boolean {
  const crossAccountActive = opts.unifiedCrossAccount && opts.accountCount > 1;
  return crossAccountActive || (opts.includeGroupInUnified && opts.hasSharedInbox);
}

const CROSS_VIEW_ORDER: CrossView[] = ['unread', 'starred', 'all'];

/**
 * Which cross-folder views (All unread / All starred / All mail) the drawer
 * lists. Alongside the unified section they all show, as before. Without it -
 * a single account, no group inbox merged in - each one shows once turned on
 * in Settings > Layout, like the webmail's per-view toggles: they span the
 * inbox and the custom folders, so even for one account they are not a repeat
 * of any single folder.
 */
export function visibleCrossViews(opts: {
  showUnified: boolean;
  enableCrossUnreadView: boolean;
  enableCrossStarredView: boolean;
  enableCrossAllView: boolean;
}): CrossView[] {
  if (opts.showUnified) return [...CROSS_VIEW_ORDER];
  const enabled: Record<CrossView, boolean> = {
    unread: opts.enableCrossUnreadView,
    starred: opts.enableCrossStarredView,
    all: opts.enableCrossAllView,
  };
  return CROSS_VIEW_ORDER.filter((view) => enabled[view]);
}
