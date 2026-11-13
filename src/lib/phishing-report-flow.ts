/**
 * The app side of "Report phishing" (#124), ported from the webmail's
 * lib/phishing-report-flow.ts and components/email/phishing-report-host.tsx:
 * the question, one report per message, then the move to Junk with
 * `$phishing`, and what the user is told.
 *
 * A message moves only once its report went out; one whose report fails
 * stays where it is. The reports need the network, so nothing starts
 * offline (the move alone could be queued, the report can't).
 */

import { useMemo } from 'react';
import { Alert } from 'react-native';
import Constants from 'expo-constants';
import type { Email, Mailbox } from '../api/types';
import { jmapClient } from '../api/jmap-client';
import { getReportOriginals, sendPhishingReport } from '../api/phishing-report';
import { useEmailStore } from '../stores/email-store';
import { reportedKey, usePhishingReportStore } from '../stores/phishing-report-store';
import { useNetworkStore } from '../stores/network-store';
import { useAuthStore } from '../stores/auth-store';
import { usePolicyStore } from '../stores/policy-store';
import { toast } from '../stores/toast-store';
import { t } from '../stores/locale-store';
import { ownMailboxes } from './mailbox-tree';
import { PHISHING_KEYWORD, phishingReportSetup, type PhishingReportSetup } from './phishing-report';

/** A message to report and the JMAP account it lives in (undefined = the user's own). */
export interface ReportTarget {
  email: Email;
  accountId?: string;
}

/** The report setup of the active account's policy; null while reporting is off. */
export function usePhishingReportSetup(): PhishingReportSetup | null {
  const policy = usePolicyStore((s) => s.effective);
  return useMemo(() => phishingReportSetup(policy), [policy]);
}

/** "Report phishing?" with the address; resolves true on Report. */
export function confirmPhishingReport(count: number, address: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      t('phishing_report.confirm_title', 'Report phishing?'),
      t('phishing_report.confirm_message', `The message goes to ${address} and moves to Junk.`, { count, address }),
      [
        { text: t('phishing_report.cancel', 'Cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: t('phishing_report.confirm', 'Report'), style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

// The login's own folder a report is created in until it is submitted.
function stagingMailboxId(mailboxes: Mailbox[]): string | null {
  const own = ownMailboxes(mailboxes);
  const box = own.find((m) => m.role === 'drafts') ?? own.find((m) => m.role === 'sent');
  return box ? box.originalId ?? box.id : null;
}

export interface PhishingReportOutcome {
  reported: ReportTarget[];
  failed: ReportTarget[];
  /** How many of the reported messages were filed in Junk. */
  moved: number;
}

/**
 * Reports each message on its own. Each one whose report went out counts as
 * reported at once (its links go off, it isn't offered again); then they are
 * filed in their accounts' Junk with `$phishing` and `$seen` through the
 * store's "Mark as spam" path (one Undo for all). A message whose report
 * failed stays where it is.
 */
export async function reportAsPhishing(targets: ReportTarget[], setup: PhishingReportSetup): Promise<PhishingReportOutcome> {
  const outcome: PhishingReportOutcome = { reported: [], failed: [], moved: 0 };
  if (targets.length === 0) return outcome;
  const staging = stagingMailboxId(useEmailStore.getState().mailboxes);
  if (!useNetworkStore.getState().online || !staging) {
    outcome.failed = targets;
    showOutcome(outcome, setup.address);
    return outcome;
  }

  // The reports go out from the login that is open now; switching login
  // points the client at another one, so the rest are left (as failed).
  const login = useAuthStore.getState().activeAccountId;
  const sameLogin = () => useAuthStore.getState().activeAccountId === login;

  // The originals as the report needs them (list rows carry no blobId),
  // one Email/get per account.
  const own = jmapClient.accountId;
  const originals = new Map<string, Email>();
  for (const accountId of new Set(targets.map((target) => target.accountId ?? own))) {
    const ids = targets.filter((target) => (target.accountId ?? own) === accountId).map((target) => target.email.id);
    try {
      for (const [id, email] of await getReportOriginals(ids, accountId)) originals.set(`${accountId}:${id}`, email);
    } catch (err) {
      console.warn('[phishing-report] could not read the messages to report', err);
    }
  }

  const appVersion = Constants.expoConfig?.version ?? 'unknown';
  for (const target of targets) {
    const sourceAccountId = target.accountId ?? own;
    const original = originals.get(`${sourceAccountId}:${target.email.id}`);
    try {
      if (!sameLogin()) throw new Error('Another login was opened');
      if (!original) throw new Error('The message is gone from the server');
      await sendPhishingReport(original, { sourceAccountId, setup, stagingMailboxId: staging, appVersion });
    } catch (err) {
      console.warn('[phishing-report] report failed', err);
      outcome.failed.push(target);
      continue;
    }
    outcome.reported.push(target);
    usePhishingReportStore.getState().markReported([reportedKey(target.email.id, target.accountId)], true);
  }

  if (outcome.reported.length > 0 && sameLogin()) {
    const address = setup.address;
    // Undo unmarks only the ones it moves back: one the server wouldn't
    // move stays reported.
    let filed: string[] = [];
    filed = await useEmailStore.getState().fileReported(outcome.reported, {
      keywords: [PHISHING_KEYWORD],
      markRead: true,
      label: (count) => t('phishing_report.done', `Reported to ${address} and moved to Junk.`, { count, address }),
      afterUndo: () => {
        usePhishingReportStore.getState().markReported(filed, false);
        toast.info(t('phishing_report.undone', 'Moved back. The report was already sent.', { count: filed.length }));
      },
    });
    outcome.moved = filed.length;
  }
  showOutcome(outcome, setup.address);
  return outcome;
}

// The Undo bar already says "Reported to … and moved to Junk."; what else
// happened goes in a toast.
function showOutcome(outcome: PhishingReportOutcome, address: string): void {
  const { reported, failed, moved } = outcome;
  if (moved < reported.length) {
    toast.warning(t('phishing_report.not_moved', `Reported to ${address}, but the message couldn't be moved to Junk.`, {
      address,
      count: reported.length - moved,
    }));
  }
  if (failed.length > 0) {
    toast.error(t('phishing_report.failed', "The message couldn't be reported.", { count: failed.length }), {
      message: failed.map(({ email }) => email.subject || t('phishing_report.no_subject', '(no subject)')).join(', '),
    });
  }
}
