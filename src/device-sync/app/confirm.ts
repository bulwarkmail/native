/**
 * The questions device sync asks outside the settings screen, as system
 * alerts: signing out while changes made on the device have not reached the
 * server (docs/device-sync.md, "Lifecycle").
 */
import { Alert } from 'react-native';
import { t } from '../../stores/locale-store';

/**
 * Asks whether to sign out although `pending` device changes (unknown when
 * the upload could not even be tried) would be lost. Resolves true to go on.
 */
export function confirmSignOutLosingChanges(pending: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const answer = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    Alert.alert(
      t('device_sync.sign_out_pending_title', 'Sign out anyway?'),
      pending > 0
        ? t(
          'device_sync.sign_out_pending_message',
          "{count, plural, one {# change made on this device hasn't reached the server. It is lost if you sign out now.} other {# changes made on this device haven't reached the server. They are lost if you sign out now.}}",
          { count: pending },
        )
        : t(
          'device_sync.sign_out_unknown_message',
          "Changes made on this device may not have reached the server. They are lost if you sign out now.",
        ),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel', onPress: () => answer(false) },
        { text: t('device_sync.sign_out_anyway', 'Sign out'), style: 'destructive', onPress: () => answer(true) },
      ],
      { cancelable: true, onDismiss: () => answer(false) },
    );
  });
}
