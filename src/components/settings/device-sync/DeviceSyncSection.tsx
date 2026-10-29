// "Sync to this device" in Settings → Contacts and Settings → Calendar
// (Android only, #34; docs/device-sync.md "Settings sections"): one block per
// signed-in account, then the accounts the app signed out while they synced
// (their data stays until the user signs in again or removes it). The panes
// pass the title and description, so the settings search indexes them where
// they are rendered.
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SettingsSection, SettingItem } from '../settings-section';
import Button from '../../Button';
import Dialog from '../../Dialog';
import { spacing, type ThemePalette } from '../../../theme/tokens';
import { useColors } from '../../../theme/colors';
import { useAccountStore } from '../../../stores/account-store';
import { useDeviceSyncStore } from '../../../stores/device-sync-store';
import { useLocaleStore } from '../../../stores/locale-store';
import { removeSuspendedAccount } from '../../../device-sync/app/lifecycle';
import type { Authority } from '../../../device-sync/types';
import type { RootStackParamList } from '../../../navigation/types';
import { DeviceSyncAccountRow } from './DeviceSyncAccountRow';

interface Props {
  authority: Authority;
  title: string;
  description: string;
}

export function DeviceSyncSection({ authority, title, description }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const accounts = useAccountStore((s) => s.accounts);
  const syncEntries = useDeviceSyncStore((s) => s.accounts);
  const suspended = React.useMemo(
    () => Object.keys(syncEntries)
      .filter((id) => syncEntries[id].suspended && !accounts.some((a) => a.id === id))
      .sort(),
    [syncEntries, accounts],
  );
  if (accounts.length === 0 && suspended.length === 0) return null;
  return (
    <View style={styles.section}>
      <SettingsSection title={title} description={description}>
        {accounts.map((account) => (
          <DeviceSyncAccountRow key={account.id} account={account} authority={authority} />
        ))}
        {suspended.map((registryId) => (
          <SuspendedAccountRow key={registryId} registryId={registryId} styles={styles} />
        ))}
      </SettingsSection>
    </View>
  );
}

// An account the app signed out (its sign-in failed) while it synced: sync is
// off, the data stays. Signing in again resumes it; removing drops it.
function SuspendedAccountRow({ registryId, styles }: { registryId: string; styles: ReturnType<typeof makeStyles> }) {
  const t = useLocaleStore((s) => s.t);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [confirming, setConfirming] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);

  const remove = async () => {
    setConfirming(false);
    setRemoving(true);
    try {
      await removeSuspendedAccount(registryId);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <View style={styles.block}>
      <SettingItem
        label={registryId}
        description={t(
          'settings.device_sync.suspended_desc',
          'Signed out. Its contacts and calendars stay on this device, with the changes made here, and sync again once you sign in.',
        )}
        noBorder
      />
      <View style={styles.actions}>
        <Button variant="outline" size="sm" onPress={() => navigation.navigate('AddAccount')}>
          {t('settings.device_sync.sign_in_again', 'Sign in again')}
        </Button>
        <Button variant="outline" size="sm" onPress={() => setConfirming(true)} loading={removing} disabled={removing}>
          {t('settings.device_sync.remove_from_device', 'Remove from this device')}
        </Button>
      </View>
      <Dialog
        visible={confirming}
        variant="destructive"
        title={t('settings.device_sync.remove_title', 'Remove from this device?')}
        message={t(
          'settings.device_sync.remove_message',
          "The account's contacts and calendars are removed from this device. Changes made here that haven't reached the server are lost.",
        )}
        confirmText={t('settings.device_sync.remove', 'Remove')}
        onConfirm={() => { void remove(); }}
        onCancel={() => setConfirming(false)}
      />
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    section: { marginTop: spacing.xxxl },
    block: {
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingBottom: spacing.md,
    },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  });
}
