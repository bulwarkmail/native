/**
 * The app side of "Report phishing" (webmail lib/phishing-report-flow.ts):
 * sends the report for one message, then moves it to Junk with $phishing,
 * read, through the store's Mark as spam, whose undo moves it back and
 * clears $phishing. The report itself can't be taken back.
 */

import Constants from 'expo-constants';
import { sendPhishingReport } from '../api/phishing-report';
import type { Email } from '../api/types';
import { useEmailStore } from '../stores/email-store';
import { PHISHING_KEYWORD, type PhishingReportSetup } from './phishing-report';

type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string;

export type PhishingReportResult = 'moved' | 'notMoved';

/**
 * Reports `email` (in `accountId`, a shared account, or the own when
 * absent). Throws when the report didn't go out; the message then stays
 * where it is.
 */
export async function reportEmailAsPhishing(
  email: Email,
  accountId: string | undefined,
  setup: PhishingReportSetup,
  t: Translate,
): Promise<PhishingReportResult> {
  await sendPhishingReport(email, {
    setup,
    sourceAccountId: accountId,
    appVersion: Constants.expoConfig?.version,
  });
  try {
    await useEmailStore.getState().markSpam([email.id], { email, accountId }, {
      keywords: [PHISHING_KEYWORD],
      markRead: true,
      label: t(
        'phishing_report.done',
        '{count, plural, one {Reported to {address} and moved to Junk.} other {# messages reported to {address} and moved to Junk.}}',
        { count: 1, address: setup.address },
      ),
    });
    return 'moved';
  } catch {
    return 'notMoved';
  }
}
