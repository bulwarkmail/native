import { Alert } from 'react-native';
import { useSettingsStore } from '../stores/settings-store';

type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

/** Shows the question; resolves true when the user went ahead. */
export type AskFn = (question: { title: string; message: string; confirmText: string; destructive: boolean; cancelText: string }) => Promise<boolean>;

const alertAsk: AskFn = ({ title, message, confirmText, destructive, cancelText }) => new Promise((resolve) => {
  Alert.alert(
    title,
    message,
    [
      { text: cancelText, style: 'cancel', onPress: () => resolve(false) },
      { text: confirmText, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ],
    { cancelable: true, onDismiss: () => resolve(false) },
  );
});

/**
 * Asks before messages are deleted or archived when the user turned on
 * "Confirm before deleting" or "Confirm before archiving" (webmail
 * lib/mail-removal-confirm.ts). Applies to the open message, the selection
 * bar and swipes. Resolves true when the action may go ahead: the setting is
 * off, or the user confirmed.
 *
 * A permanent delete has its own, stronger question; ask this one only when
 * no other confirmation is shown, so nobody is asked twice.
 */
export async function confirmMailRemoval(
  kind: 'delete' | 'archive',
  count: number,
  t: Translate,
  ask: AskFn = alertAsk,
): Promise<boolean> {
  const settings = useSettingsStore.getState();
  if (!(kind === 'delete' ? settings.confirmDelete : settings.confirmArchive)) return true;
  if (count <= 0) return true;
  const params = { count };
  return kind === 'delete'
    ? ask({
      title: t('email_list.confirm_remove.delete_title', '{count, plural, one {Delete this email?} other {Delete # emails?}}', params),
      message: t('email_list.confirm_remove.delete_message', '{count, plural, one {It moves to the trash.} other {They move to the trash.}}', params),
      confirmText: t('email_list.confirm_remove.delete', 'Delete', params),
      cancelText: t('common.cancel', 'Cancel'),
      destructive: true,
    })
    : ask({
      title: t('email_list.confirm_remove.archive_title', '{count, plural, one {Archive this email?} other {Archive # emails?}}', params),
      message: t('email_list.confirm_remove.archive_message', '{count, plural, one {It moves to your archive.} other {They move to your archive.}}', params),
      confirmText: t('email_list.confirm_remove.archive', 'Archive', params),
      cancelText: t('common.cancel', 'Cancel'),
      destructive: false,
    });
}
