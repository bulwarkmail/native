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
