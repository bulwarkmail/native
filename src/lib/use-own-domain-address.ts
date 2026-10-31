import React from 'react';
import { useAuthStore } from '../stores/auth-store';
import { useSettingsStore } from '../stores/settings-store';
import { toUnicodeEmailOnOwnDomains } from './idn';

/**
 * Formats an address from a message for display: on one of the signed-in
 * user's own IDN domains it reads as written (`bücher.de`), anywhere else it
 * stays as the message has it (see toUnicodeEmailOnOwnDomains; webmail
 * hooks/use-own-domain-address.ts, #1100).
 */
export function useOwnDomainAddress(): (address: string) => string {
  const username = useAuthStore((s) => s.username);
  const identities = useSettingsStore((s) => s.identities);
  const ownAddresses = React.useMemo(
    () => [username, ...identities.map((i) => i.email)],
    [username, identities],
  );
  return React.useCallback(
    (address: string) => toUnicodeEmailOnOwnDomains(address, ownAddresses),
    [ownAddresses],
  );
}
