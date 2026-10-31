import type { JMAPAccountInfo } from '../api/types';

/**
 * Whether the user may use a capability's methods with an account (webmail
 * JMAPClient.accountSupports, #1239). The account's own accountCapabilities
 * decide (RFC 8620 2): a server can advertise a capability while an account
 * has the matching rights revoked. Some shared accounts list no capabilities
 * at all, so a shared account (isPersonal false) with an empty list falls
 * back to the server-wide capability, as does a server that populates no
 * accountCapabilities anywhere. A shared account that lists capabilities but
 * not this one used to count as capable.
 */
export function accountSupports(
  account: JMAPAccountInfo | undefined,
  sessionCapabilities: Record<string, unknown> | undefined,
  capability: string,
): boolean {
  if (!sessionCapabilities || !(capability in sessionCapabilities)) return false;
  if (!account) return false;
  const caps = account.accountCapabilities;
  if (caps && capability in caps) return true;
  if (caps && Object.keys(caps).length > 0) return false;
  return true;
}
