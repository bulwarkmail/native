import React from 'react';
import type { Email } from '../../api/types';
import { describeSenderVerification, senderWarningOf } from '../../lib/email-headers';
import { useLocaleStore } from '../../stores/locale-store';

/**
 * The sender-check label of a message whose From the receiving server's
 * checks don't back, the same verdict as the notice in the reader. Avatars
 * show it instead of the claimed sender's favicon or photo (webmail
 * use-sender-warning.ts, #1439). Undefined when the check passed, there are
 * no results to judge by, or no message is given (Sent and Drafts rows show
 * the recipient, whose avatar the check says nothing about).
 */
export function useSenderWarning(email: Pick<Email, 'headers' | 'from'> | undefined): string | undefined {
  const t = useLocaleStore((s) => s.t);
  const verification = React.useMemo(() => (email ? senderWarningOf(email) : null), [email]);
  return verification ? describeSenderVerification(verification, t).label : undefined;
}
