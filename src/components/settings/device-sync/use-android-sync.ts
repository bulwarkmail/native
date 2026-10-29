// Android's side of one account's device sync for the settings: whether the
// Android account exists, its automatic sync for the authority (the switch),
// the device's master auto-sync, whether a sync runs or waits, and whether
// the runtime permissions are still granted. Re-read on mount, when the app
// returns to the foreground, when accounts of our type change, and every few
// seconds while a sync runs or waits.
import React from 'react';
import { AppState } from 'react-native';
import { getSyncSettings, listAndroidAccounts, onAccountsChanged } from '../../../device-sync/native';
import { hasSyncPermissions } from '../../../device-sync/app/permissions';
import type { Authority } from '../../../device-sync/types';

export interface AndroidSyncView {
  /** The Android account exists. */
  exists: boolean;
  /** Automatic sync for the authority: the toggle in Settings → Accounts. */
  automatic: boolean;
  /** The device's "Auto-sync data". */
  masterAutomatic: boolean;
  active: boolean;
  pending: boolean;
}

const POLL_MS = 3000;

export function useAndroidSync(accountName: string | undefined, authority: Authority): {
  view: AndroidSyncView | null;
  permitted: boolean | null;
  refresh: () => Promise<void>;
} {
  const [view, setView] = React.useState<AndroidSyncView | null>(null);
  const [permitted, setPermitted] = React.useState<boolean | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  // Read at call time: turning sync on creates the account while the
  // caller still holds the refresh of the render before.
  const nameRef = React.useRef(accountName);
  nameRef.current = accountName;
  // Only the latest read may land; an older one resolving late is stale.
  const reads = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const read = ++reads.current;
    const accountName = nameRef.current;
    const granted = await hasSyncPermissions(authority);
    let next: AndroidSyncView = { exists: false, automatic: false, masterAutomatic: true, active: false, pending: false };
    if (accountName) {
      try {
        const accounts = await listAndroidAccounts();
        if (accounts.some((a) => a.name === accountName)) {
          const settings = await getSyncSettings(accountName);
          const own = settings.authorities?.[authority];
          next = {
            exists: true,
            automatic: !!own?.automatic,
            masterAutomatic: settings.masterAutomatic !== false,
            active: !!own?.active,
            pending: !!own?.pending,
          };
        }
      } catch {
        // Shown as off until the next read.
      }
    }
    if (!alive.current || read !== reads.current) return;
    setPermitted(granted);
    setView(next);
  }, [authority]);

  React.useEffect(() => {
    void refresh();
  }, [refresh, accountName]);

  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = onAccountsChanged(() => { void refresh(); });
    } catch {
      // Foreground reads still catch up.
    }
    return () => {
      subscription.remove();
      unsubscribe();
    };
  }, [refresh]);

  const busy = !!view?.active || !!view?.pending;
  React.useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  return { view, permitted, refresh };
}
