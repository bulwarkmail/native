/**
 * How a mail list row names an address: its display name, else the address
 * itself, formatted by the caller (useOwnDomainAddress: the user's own IDN
 * domains read as written, `bücher.de`), else the "unknown" label (webmail
 * components/email/thread-list-item.tsx, #1100).
 */
export function listAddressLabel(
  address: { name?: string | null; email?: string | null } | undefined,
  formatAddress: (address: string) => string,
  unknown: string,
): string {
  return address?.name || (address?.email ? formatAddress(address.email) : '') || unknown;
}

/**
 * Whether a list row names its recipient instead of its sender. Sent and
 * Drafts name the recipient (webmail 1.4.12). A search started there runs
 * over every folder unless it is narrowed (`folderScope` other than
 * 'current'), so the open folder says nothing about a row: the row's own
 * folders decide, matched on each folder's raw id. `rowMailboxes` are the
 * folders of the row's account.
 */
export function rowShowsRecipient(
  mailboxIds: Record<string, boolean> | undefined,
  rowMailboxes: ReadonlyArray<{ id: string; originalId?: string; role?: string | null }>,
  listRole: string | null | undefined,
  folderScope: string,
): boolean {
  if (folderScope === 'current') return listRole === 'sent' || listRole === 'drafts';
  return rowMailboxes.some((m) => (m.role === 'sent' || m.role === 'drafts') && !!mailboxIds?.[m.originalId ?? m.id]);
}
