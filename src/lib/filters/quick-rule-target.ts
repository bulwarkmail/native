import { jmapClient } from '../../api/jmap-client';
import { accountSupportsSieve, getSieveAccountId } from '../../api/sieve';
import type { Email, Mailbox } from '../../api/types';
import { useAccountStore } from '../../stores/account-store';
import { accountIdOfRow, useEmailStore } from '../../stores/email-store';
import { clientServesActiveAccount } from '../active-client-account';
import { mailboxesOfAccount } from '../mailbox-tree';

/** The account a rule made from a message goes into, and the folder it starts from. */
export interface QuickRuleTarget {
  /** App account (account-store id) the app is signed in as; null when unknown. */
  appAccountId: string | null;
  /** JMAP account the message lives in. */
  jmapAccountId: string;
  /** Account whose Sieve script a rule is written to. */
  sieveAccountId: string;
  /** Appears with `appAccountId` so two logins sharing a JMAP id never compare equal. */
  key: string;
  /** A shared or team account: Rules are hidden for it, as in webmail. */
  shared: boolean;
  supportsSieve: boolean;
  /** The account's own folders (store ids; a shared folder's raw id is `originalId`). */
  mailboxes: Mailbox[];
  /** Server id of the folder the message is in, within `jmapAccountId`; null when unknown. */
  sourceMailboxId: string | null;
}

export interface QuickRuleTargetOptions {
  /**
   * The viewer's account for the message (undefined = the user's own). Give
   * the key even when undefined: the viewer's answer then wins over the
   * list's stamp.
   */
  viewedAccountId?: string;
  /** The folder to apply from, as the server knows it. */
  sourceMailboxId?: string | null;
}

const rawId = (m: Mailbox) => m.originalId ?? m.id;

/**
 * Resolve the account of `email` the way the email actions do, so a rule for
 * a message of account B is never written to account A. The viewer passes its
 * `viewed.accountId`; a list row is read from its stamp. Null while the
 * client does not serve the active account (an account switch is under way).
 */
export function resolveQuickRuleTarget(
  email: Email,
  options: QuickRuleTargetOptions = {},
): QuickRuleTarget | null {
  if (!jmapClient.isConnected || !clientServesActiveAccount()) return null;
  const own = jmapClient.accountId;
  const stated = 'viewedAccountId' in options ? options.viewedAccountId : accountIdOfRow(email);
  const accountId = stated && stated !== own ? stated : undefined;
  const jmapAccountId = accountId ?? own;
  const shared = accountId !== undefined;

  const state = useEmailStore.getState();
  const mailboxes = mailboxesOfAccount(state.mailboxes, accountId);
  const sieveAccountId = shared ? jmapAccountId : getSieveAccountId();
  const session = jmapClient.currentSession;
  const appAccountId = useAccountStore.getState().activeAccountId ?? null;

  let sourceMailboxId: string | null;
  if (options.sourceMailboxId !== undefined) {
    sourceMailboxId = options.sourceMailboxId;
  } else {
    // The open folder when the message is in it, else its own folder (unified,
    // tag and search views have no real folder selected).
    const inFolders = mailboxes.filter((m) => email.mailboxIds?.[rawId(m)] || email.mailboxIds?.[m.id]);
    const selected = inFolders.find((m) => m.id === state.currentMailboxId);
    const found = selected ?? inFolders[0];
    sourceMailboxId = found ? rawId(found) : null;
  }

  return {
    appAccountId,
    jmapAccountId,
    sieveAccountId,
    key: `${appAccountId ?? ''}|${jmapAccountId}`,
    shared,
    supportsSieve: accountSupportsSieve(session?.accounts?.[sieveAccountId], session?.capabilities),
    mailboxes,
    sourceMailboxId,
  };
}
