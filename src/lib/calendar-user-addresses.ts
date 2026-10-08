import React from 'react';
import { useAccountStore } from '../stores/account-store';
import { identityScope, useSettingsStore } from '../stores/settings-store';
import { jmapClient } from '../api/jmap-client';
import { fetchPrincipal } from '../api/account-security';
import { collectUserCalendarAddresses } from './calendar-participants';
import { useCalendarStore } from '../stores/calendar-store';

// Account aliases come from x:Account/get (Stalwart's principal object) and
// only change when an admin edits the account, so they're fetched once per
// signed-in account (server, login and JMAP id: two servers hand out the same
// JMAP ids) and remembered for the session, and only by a view that needs
// them. Failure (older server, no permission: only admins may read it) simply
// leaves the list at login address + identities.
const aliasCache = new Map<string, string[]>();
const aliasInFlight = new Map<string, Promise<string[]>>();
const aliasListeners = new Set<() => void>();
const NO_IDENTITIES: never[] = [];

function fetchAliases(scope: string): Promise<string[]> {
  const cached = aliasCache.get(scope);
  if (cached) return Promise.resolve(cached);
  const pending = aliasInFlight.get(scope);
  if (pending) return pending;
  const p = fetchPrincipal()
    .then((info) => info.emails)
    .catch(() => [] as string[])
    .then((emails) => {
      aliasCache.set(scope, emails);
      aliasInFlight.delete(scope);
      for (const l of aliasListeners) l();
      return emails;
    });
  aliasInFlight.set(scope, p);
  return p;
}

/** The scheduling addresses of the user's ParticipantIdentity list (no `mailto:`). */
export function identityAddresses(
  identities: ReadonlyArray<{ calendarAddress: string }> | undefined,
): string[] {
  return (identities ?? []).map((i) => i.calendarAddress.replace(/^mailto:/i, ''));
}

/** Test hook: forget cached aliases (also useful after re-login). */
export function resetUserCalendarAddressCache(): void {
  aliasCache.clear();
  aliasInFlight.clear();
}

/**
 * Every address the signed-in user can be addressed at for scheduling: the
 * login address, the sending identities and the account aliases. Used to
 * find "me" among an event's participants (RSVP), to detect alias-organized
 * events as the user's own, and as the organizer address of new invites.
 * `loadAliases: false` skips the alias lookup (a message that carries no
 * invitation).
 */
export function useUserCalendarAddresses(loadAliases = true): string[] {
  const activeEmail = useAccountStore((s) => s.getActiveAccount()?.email ?? null);
  const heldIdentities = useSettingsStore((s) => s.identities);
  const identitiesFor = useSettingsStore((s) => s.identitiesFor);
  const [, bump] = React.useReducer((n: number) => n + 1, 0);

  const accountId = jmapClient.isConnected ? jmapClient.accountId : null;
  const scope = accountId ? identityScope() : null;
  React.useEffect(() => {
    if (!scope || !loadAliases) return;
    if (aliasCache.has(scope)) return;
    aliasListeners.add(bump);
    void fetchAliases(scope);
    return () => { aliasListeners.delete(bump); };
  }, [scope, loadAliases]);

  // Identities still held for the account signed in before are not this one's.
  const identities = scope !== null && identitiesFor === scope ? heldIdentities : NO_IDENTITIES;
  const participantIdentities = useCalendarStore((s) => (accountId ? s.participantIdentities[accountId] : undefined));
  const aliases = scope ? aliasCache.get(scope) ?? [] : [];
  return React.useMemo(
    () => collectUserCalendarAddresses(
      [activeEmail],
      identities.map((i) => i.email),
      aliases,
      identityAddresses(participantIdentities),
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeEmail, identities, aliases.join('|'), participantIdentities],
  );
}

/**
 * `addresses` (the signed-in user's) when they belong to app account
 * `appAccountId`: it is the one shown and the one signed in. Otherwise none,
 * so mid-switch another account's addresses never make the user the
 * organizer of this account's event.
 */
export function addressesForAccount(
  appAccountId: string | null | undefined,
  accounts: { shown: string | null; signedIn: string | null },
  addresses: string[],
): string[] {
  if (!appAccountId || appAccountId !== accounts.shown || appAccountId !== accounts.signedIn) return [];
  return addresses;
}
