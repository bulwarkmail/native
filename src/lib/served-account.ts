import React from 'react';
import { jmapClient } from '../api/jmap-client';
import { useAuthStore } from '../stores/auth-store';
import { useEmailStore } from '../stores/email-store';
import { clientServesAccount } from './active-client-account';

/**
 * The JMAP account the client serves for app account `appAccountId`, or ''
 * while it serves another one (an account switch in progress) or none. Ids
 * repeat across accounts, so a read keyed by the JMAP id alone must wait for
 * this rather than take whatever the client is on.
 */
export function servedJmapAccountId(appAccountId: string | null | undefined): string {
  if (!appAccountId || !jmapClient.isConnected || !clientServesAccount(appAccountId)) return '';
  try {
    return jmapClient.accountId ?? '';
  } catch {
    return '';
  }
}

export interface ServedAccount {
  /** The app account shown now. */
  appAccountId: string | null;
  /** Its JMAP account once the client serves it, else ''. */
  jmapAccountId: string;
}

/**
 * The shown account and, once the client serves it, its JMAP account. Re-
 * renders on a switch (the shown account) and when the new connection is
 * committed (the auth session), so work keyed by it re-runs for the account
 * the app shows and retries once that account is served.
 */
export function useServedAccount(): ServedAccount {
  const appAccountId = useEmailStore((s) => s.activeAccountId);
  const session = useAuthStore((s) => s.session);
  const jmapAccountId = React.useMemo(
    () => {
      void session;
      return servedJmapAccountId(appAccountId);
    },
    [appAccountId, session],
  );
  return React.useMemo(() => ({ appAccountId, jmapAccountId }), [appAccountId, jmapAccountId]);
}
