import { useEffect } from 'react';
import { jmapClient } from '../../api/jmap-client';
import {
  advertisesArchivedItems,
  hasArchivedEmail,
  queryArchivedItemIds,
} from '../../api/archived-items';
import { useAuthStore } from '../../stores/auth-store';
import { recoveryPolicy } from './policy';
import { usePolicyStore } from '../../stores/policy-store';
import { recoveryKey, useRecoveryStore, type RecoveryClient } from './recovery-store';

/** The archive calls for one JMAP account, as the detection store asks them. */
export function recoveryClientFor(accountId: string): RecoveryClient {
  return {
    advertisesArchivedItems: () => advertisesArchivedItems(accountId),
    queryArchivedItemIds: (options) => queryArchivedItemIds(accountId, options),
    hasArchivedEmail: (options) => hasArchivedEmail(accountId, options),
  };
}

export interface DeletedItemsRecovery {
  /** Offered for the active account (the server has the feature). */
  available: boolean;
  /** The JMAP account the page is for; null while there is no session. */
  accountId: string | null;
  /** The detection cache key of the active account. */
  key: string | null;
}

/**
 * Whether "Recover deleted items" is offered for the active account
 * (webmail hooks/use-deleted-items-recovery.ts). Nothing is asked until the
 * live session is in, nor when the policy hides it (see ./policy). Then the
 * server must answer x:ArchivedItem/query (Stalwart with an Enterprise
 * license). Asked once per account and app run, and again after a refusal
 * once its retry time comes, also while Settings stays open.
 */
export function useDeletedItemsRecovery(): DeletedItemsRecovery {
  const session = useAuthStore((s) => s.session);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  // connectedAccountId, not accountId: the client is between sessions while an
  // account switch reconnects, and accountId throws then (a crash in render).
  const accountId = session ? jmapClient.connectedAccountId : null;
  const off = usePolicyStore((s) => recoveryPolicy(s.effective).hidden);
  const key = accountId ? recoveryKey(activeAccountId, accountId) : null;
  const check = useRecoveryStore((s) => (key ? s.checks[key] : undefined));
  const detect = useRecoveryStore((s) => s.detect);

  useEffect(() => {
    if (off || !accountId || !key) return undefined;
    if (!check) {
      void detect(recoveryClientFor(accountId), key);
      return undefined;
    }
    if (check.supported || check.retryAt === null || !Number.isFinite(check.retryAt)) return undefined;
    const timer = setTimeout(
      () => void detect(recoveryClientFor(accountId), key, { force: true }),
      Math.max(0, check.retryAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [off, accountId, key, check, detect]);

  return { available: !off && !!check?.supported, accountId, key };
}
