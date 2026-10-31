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
