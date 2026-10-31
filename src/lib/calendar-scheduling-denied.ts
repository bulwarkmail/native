import { Alert } from 'react-native';
import { JMAPMethodError } from '../api/jmap-result';

type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

/**
 * Why the server refused a save because of the invitations it would send, or
 * null for any other failure. Stalwart 0.16.21+ fails the whole
 * CalendarEvent/set with `forbidden` when the account may not send
 * scheduling messages; the same change without them can still be saved
 * (webmail lib/jmap/scheduling-error.ts).
 */
export function schedulingDeniedReason(err: unknown, sentScheduling: boolean): string | null {
  if (!sentScheduling || !(err instanceof JMAPMethodError) || err.type !== 'forbidden') return null;
  // The thrower's message carries the server's description after the type.
  const description = err.message.split(' – ').slice(1).join(' – ').trim();
  return description || err.message || 'forbidden';
}

/** Ask whether to save the event without its invitations; resolves true for "Save without invitations". */
export function askSaveWithoutInvitations(reason: string, t: Translate): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      t('calendar.notifications.invitations_denied_title', "Invitations can't be sent"),
      t('calendar.notifications.invitations_denied', 'The server refused to send the invitations: {reason}. Save the event without sending them?', { reason }),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: t('calendar.notifications.save_without_invitations', 'Save without invitations'), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/**
 * Save with the invitations `send` asks for; when the server refuses to send
 * them, ask and save again without. Resolves false when the user kept the
 * editor open instead.
 */
export async function saveOfferingWithoutInvitations(
  save: (send: boolean) => Promise<void> | void,
  send: boolean,
  t: Translate,
  ask: (reason: string, t: Translate) => Promise<boolean> = askSaveWithoutInvitations,
): Promise<boolean> {
  try {
    await save(send);
    return true;
  } catch (err) {
    const reason = schedulingDeniedReason(err, send);
    if (reason === null) throw err;
    if (!(await ask(reason, t))) return false;
    await save(false);
    return true;
  }
}
