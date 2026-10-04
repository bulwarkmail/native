// The address books or calendars of one account for the device sync settings,
// listed through the account's own client (device-sync/app/collections) and
// cached for a little while, so the chooser, the counts and the "new contacts
// go to" picker share one request.
import React from 'react';
import {
  cachedSyncCollections,
  CollectionsError,
  listSyncCollections,
  onSyncCollectionsLoaded,
  type CollectionsErrorKind,
  type SyncCollection,
} from '../../../device-sync/app/collections';
import { CALENDAR_AUTHORITY, type Authority } from '../../../device-sync/types';
import { useAuthStore } from '../../../stores/auth-store';
import { useAccountSubscriptions } from '../../../stores/calendar-subscriptions-store';

export type CollectionsState =
  | { kind: 'idle' }
  | { kind: 'loading'; collections: SyncCollection[] | null }
  | { kind: 'loaded'; collections: SyncCollection[] }
  | { kind: 'error'; error: CollectionsErrorKind };

export function useSyncCollections(registryId: string, authority: Authority, active: boolean): {
  state: CollectionsState;
  reload: () => void;
} {
  const [state, setState] = React.useState<CollectionsState>(() => {
    const cached = cachedSyncCollections(registryId, authority);
    return cached ? { kind: 'loaded', collections: cached } : { kind: 'idle' };
  });
  const [attempt, setAttempt] = React.useState(0);
  // Calendars mirroring subscribed feeds are read-only on the device. Only
  // the active account's subscriptions are known here.
  const isActive = useAuthStore((s) => s.activeAccountId === registryId);
  const subscriptions = useAccountSubscriptions();
  // Keyed on the calendars so a store write that changes nothing here doesn't
  // re-run the network listing below.
  const feedsKey = subscriptions.map((sub) => `${sub.accountId ?? ''}|${sub.calendarId}`).sort().join(',');
  const feeds = React.useMemo(
    () => (authority === CALENDAR_AUTHORITY && isActive
      ? subscriptions.map((sub) => ({ calendarId: sub.calendarId, accountId: sub.accountId }))
      : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [authority, isActive, feedsKey],
  );

  React.useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const force = attempt > 0;
    setState((prev) => ({ kind: 'loading', collections: prev.kind === 'loaded' ? prev.collections : null }));
    listSyncCollections(registryId, authority, { force, feeds })
      .then((collections) => {
        if (!cancelled) setState({ kind: 'loaded', collections });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', error: err instanceof CollectionsError ? err.kind : 'server' });
      });
    return () => { cancelled = true; };
  }, [registryId, authority, active, attempt, feeds]);

  // The chooser loads its own, fresher list: the row's counts follow it.
  React.useEffect(
    () => onSyncCollectionsLoaded((id, auth, collections) => {
      if (id === registryId && auth === authority) setState({ kind: 'loaded', collections });
    }),
    [registryId, authority],
  );

  const reload = React.useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
