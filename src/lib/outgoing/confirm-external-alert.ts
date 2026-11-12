import { Alert } from 'react-native';
import type { ExternalRecipient } from '../external-mail';

type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string;

/**
 * "Send outside your organisation?" as an alert, for the surfaces without
 * the composer's send-check sheet: quick reply and the event editor's
 * invitations (webmail external-recipient-confirm.tsx). True to send.
 */
export function confirmExternalRecipientsAlert(recipients: ExternalRecipient[], t: Translate): Promise<boolean> {
  if (recipients.length === 0) return Promise.resolve(true);
  const field = {
    to: t('external_mail.field_to', 'To'),
    cc: t('external_mail.field_cc', 'Cc'),
    bcc: t('external_mail.field_bcc', 'Bcc'),
  };
  const list = recipients.map((r) => `${field[r.field]}: ${r.address}`).join('\n');
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      t('external_mail.confirm_title', 'Send outside your organisation?'),
      `${t(
        'external_mail.confirm_message',
        '{count, plural, one {This recipient is} other {These # recipients are}} outside your organisation. Send only if you mean to.',
        { count: recipients.length },
      )}\n\n${list}`,
      [
        { text: t('external_mail.back', 'Back'), style: 'cancel', onPress: () => resolve(false) },
        { text: t('external_mail.send_anyway', 'Send anyway'), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
