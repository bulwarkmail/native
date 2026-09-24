import React from 'react';
import { useAccountStore } from '../stores/account-store';
import { useSettingsStore } from '../stores/settings-store';
import { jmapClient } from '../api/jmap-client';
import { fetchPrincipal } from '../api/account-security';
import { collectUserCalendarAddresses } from './calendar-participants';

// Account aliases come from x:Account/get (Stalwart's principal object) and
// only change when an admin edits the account, so they're fetched once per
// JMAP account and remembered for the session, and only by a view that needs
// them. Failure (older server, no permission: only admins may read it) simply
// leaves the list at login address + identities.
const aliasCache = new Map<string, string[]>();
const aliasInFlight = new Map<string, Promise<string[]>>();
const aliasListeners = new Set<() => void>();

function fetchAliases(accountId: string): Promise<string[]> {
  const cached = aliasCache.get(accountId);
  if (cached) return Promise.resolve(cached);
  const pending = aliasInFlight.get(accountId);
  if (pending) return pending;
  const p = fetchPrincipal()
    .then((info) => info.emails)
    .catch(() => [] as string[])
    .then((emails) => {
      aliasCache.set(accountId, emails);
      aliasInFlight.delete(accountId);
      for (const l of aliasListeners) l();
      return emails;
    });
  aliasInFlight.set(accountId, p);
  return p;
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
  const identities = useSettingsStore((s) => s.identities);
  const [, bump] = React.useReducer((n: number) => n + 1, 0);

  const accountId = jmapClient.isConnected ? jmapClient.accountId : null;
  React.useEffect(() => {
    if (!accountId || !loadAliases) return;
    if (aliasCache.has(accountId)) return;
    aliasListeners.add(bump);
    void fetchAliases(accountId);
    return () => { aliasListeners.delete(bump); };
  }, [accountId, loadAliases]);

  const aliases = accountId ? aliasCache.get(accountId) ?? [] : [];
  return React.useMemo(
    () => collectUserCalendarAddresses(
      [activeEmail],
      identities.map((i) => i.email),
      aliases,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeEmail, identities, aliases.join('|')],
  );
}
