// One signed-in account in "Sync to this device" (docs/device-sync.md,
// "Settings sections"): the switch (Android's automatic sync for the
// authority), the status or the error with what to do about it, and, while
// sync is on, which collections sync, where new contacts go or who reminds of
// events, the interval, "Sync now" and Android's account settings.
import React from 'react';
import { Alert, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AlertTriangle, RefreshCw, Settings as SettingsIcon, XCircle } from '../../icons';
import { SettingItem, Select, RadioGroup, ToggleSwitch } from '../settings-section';
import Button from '../../Button';
import Dialog from '../../Dialog';
import { spacing, typography, type ThemePalette } from '../../../theme/tokens';
import { useColors } from '../../../theme/colors';
import { useLocaleStore, type TranslateFn } from '../../../stores/locale-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { useAccountStore, type AccountEntry } from '../../../stores/account-store';
import {
  effectiveSelection,
  emptyAccountDeviceSync,
  intervalFor,
  syncOnInApp,
  useDeviceSyncStore,
} from '../../../stores/device-sync-store';
import {
  changeReminderOwner,
  changeSyncInterval,
  disableDeviceSync,
  enableDeviceSync,
  openAndroidAccountSettings,
  resolveDeletions,
  resumeDeviceSync,
  syncNow,
} from '../../../device-sync/app/lifecycle';
import { hasSyncPermissions, openAppSystemSettings, requestSyncPermissions } from '../../../device-sync/app/permissions';
import { CALENDAR_AUTHORITY, CONTACTS_AUTHORITY, type Authority, type ReminderOwner } from '../../../device-sync/types';
import type { RootStackParamList } from '../../../navigation/types';
import { DeviceSyncCollectionsSheet } from './DeviceSyncCollectionsSheet';
import { describeSyncStatus, type StatusAction } from './status';
import { useAndroidSync } from './use-android-sync';
import { useSyncCollections } from './use-sync-collections';
import { nameWithAccount } from '../../../lib/address-book-label';
import { deviceSyncAccountLabel } from './account-label';

interface Props {
  account: AccountEntry;
  authority: Authority;
}

type Busy = 'on' | 'off' | 'sync' | null;

type Prompt =
  | { kind: 'rationale' }
  | { kind: 'blocked' }
  | { kind: 'pending'; pending: number };

/** Asks who reminds of synced events; null when the user backed out. */
function askReminderOwner(t: TranslateFn): Promise<ReminderOwner | null> {
  return new Promise((resolve) => {
    let settled = false;
    const answer = (owner: ReminderOwner | null) => {
      if (settled) return;
      settled = true;
      resolve(owner);
    };
    Alert.alert(
      t('settings.device_sync.reminder_question_title', 'Who should remind you?'),
      t(
        'settings.device_sync.reminder_question_message',
        'Synced events can remind you from the calendar app on this device or from Bulwark. Pick one so you are not reminded twice. You can change it later.',
      ),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel', onPress: () => answer(null) },
        { text: t('settings.device_sync.reminder_owner_bulwark', 'Bulwark'), onPress: () => answer('bulwark') },
        { text: t('settings.device_sync.reminder_owner_device', 'Calendar app'), onPress: () => answer('device') },
      ],
      { cancelable: true, onDismiss: () => answer(null) },
    );
  });
}

/** How often the status line's "… ago" is brought up to date. */
const RELATIVE_TIME_REFRESH_MS = 30_000;

export function DeviceSyncAccountRow({ account, authority }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const storedEntry = useDeviceSyncStore((s) => s.accounts[account.id]);
  const entry = React.useMemo(() => storedEntry ?? emptyAccountDeviceSync(), [storedEntry]);
  const calendarReminders = useSettingsStore((s) => s.calendarNotificationsEnabled);
  const isContacts = authority === CONTACTS_AUTHORITY;

  const onInApp = syncOnInApp(entry, authority);
  const { view, permitted, refresh } = useAndroidSync(entry.androidAccountName, authority);
  const [busy, setBusy] = React.useState<Busy>(null);
  // "Synced 2 min ago" keeps counting while the settings stay open.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), RELATIVE_TIME_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const [prompt, setPrompt] = React.useState<Prompt | null>(null);
  const [chooserOpen, setChooserOpen] = React.useState(false);

  // The switch follows Android; until Android answered, what the app knows.
  const androidOn = view ? view.exists && view.automatic : onInApp;
  const checked = busy === 'on' ? true : busy === 'off' ? false : androidOn;
  const paused = onInApp && !!view?.exists && !view.automatic;
  const showDetails = (checked || paused) && busy !== 'off';

  const { state: collectionsState } = useSyncCollections(account.id, authority, showDetails);
  const collections = collectionsState.kind === 'loaded' ? collectionsState.collections : null;
  const selectedKeys = React.useMemo(
    () => (collections ? effectiveSelection(entry, authority, collections) : null),
    [collections, entry, authority],
  );

  const accounts = useAccountStore((s) => s.accounts);
  const accountLabel = React.useMemo(() => deviceSyncAccountLabel(account, accounts), [account, accounts]);
  const status = describeSyncStatus(
    {
      authority,
      on: checked,
      paused,
      removed: !!entry.removedInAndroidSettings,
      permitted,
      syncing: !!view?.active,
      lastRun: entry.lastRun[authority],
      now,
    },
    t,
  );

  const alertFailed = (message: string) => {
    Alert.alert(
      t('settings.device_sync.failed_title', 'Sync could not be turned on'),
      message,
      [{ text: t('settings.device_sync.ok', 'OK') }],
    );
  };

  const alertDenied = () => {
    Alert.alert(
      t('settings.device_sync.denied_title', 'Sync stays off'),
      isContacts
        ? t('settings.device_sync.denied_contacts', 'Without access to contacts, Bulwark cannot put your address books on this device.')
        : t('settings.device_sync.denied_calendar', 'Without access to calendars, Bulwark cannot put your calendars on this device.'),
      [{ text: t('settings.device_sync.ok', 'OK') }],
    );
  };

  const turnOn = async () => {
    setPrompt(null);
    setBusy('on');
    try {
      const permission = await requestSyncPermissions(authority);
      if (permission === 'blocked') {
        setPrompt({ kind: 'blocked' });
        return;
      }
      if (permission === 'denied') {
        alertDenied();
        return;
      }
      if (authority === CALENDAR_AUTHORITY && entry.reminderOwner == null) {
        // Bulwark reminds nobody while its event notifications are off: the
        // calendar app does, without asking.
        const owner = calendarReminders ? await askReminderOwner(t) : 'device';
        if (!owner) return;
        await changeReminderOwner(account.id, owner);
      }
      const outcome = await enableDeviceSync(account.id, authority);
      if (outcome.kind === 'permission') alertDenied();
      else if (outcome.kind === 'failed') alertFailed(outcome.message);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const startTurnOn = async () => {
    // Explain first, unless access was granted before (another account).
    if (await hasSyncPermissions(authority)) void turnOn();
    else setPrompt({ kind: 'rationale' });
  };

  const turnOff = async (force: boolean) => {
    setPrompt(null);
    setBusy('off');
    try {
      const result = await disableDeviceSync(account.id, authority, { force });
      if (result.done) return;
      if (!force) {
        setPrompt({ kind: 'pending', pending: result.pending });
        return;
      }
      Alert.alert(
        t('settings.device_sync.turn_off_failed_title', 'Sync could not be turned off'),
        t(
          'settings.device_sync.turn_off_failed',
          'The synced data could not be removed from this device. Sync is paused; try again later.',
        ),
        [{ text: t('settings.device_sync.ok', 'OK') }],
      );
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const keepSyncing = async () => {
    setPrompt(null);
    await resumeDeviceSync(account.id, authority);
    void refresh();
  };

  const handleSyncNow = async () => {
    setBusy('sync');
    try {
      await syncNow(account.id, authority);
    } catch (err) {
      alertFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const grantAccess = async () => {
    const permission = await requestSyncPermissions(authority);
    if (permission === 'blocked') setPrompt({ kind: 'blocked' });
    else if (permission === 'denied') alertDenied();
    else if (checked) await syncNow(account.id, authority).catch(() => false);
    void refresh();
  };

  const reviewDeletions = () => {
    const resolve = (choice: 'delete' | 'restore') => {
      void resolveDeletions(account.id, authority, choice)
        .catch((err: unknown) => alertFailed(err instanceof Error ? err.message : String(err)))
        .finally(() => { void refresh(); });
    };
    Alert.alert(
      t('settings.device_sync.deletions_title', 'Delete them on the server too?'),
      t(
        'settings.device_sync.deletions_message',
        'Many items were deleted on this device at once, so they were not deleted on the server. Delete them there as well, or bring them back on this device.',
      ),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        { text: t('settings.device_sync.deletions_restore', 'Bring them back'), onPress: () => resolve('restore') },
        { text: t('settings.device_sync.deletions_delete', 'Delete on server'), style: 'destructive', onPress: () => resolve('delete') },
      ],
    );
  };

  const runAction = (action: StatusAction) => {
    if (action === 'signIn') navigation.navigate('AddAccount');
    else if (action === 'grantAccess') void grantAccess();
    else reviewDeletions();
  };

  const closeChooser = (changed: boolean) => {
    setChooserOpen(false);
    // A new selection is loaded (or dropped) by the next sync: run it now.
    // (A sync Android paused would only report that it is off.)
    if (changed && checked) void syncNow(account.id, authority).catch(() => false);
  };

  const intervalOptions = [
    { value: '900', label: t('settings.device_sync.interval_15m', 'Every 15 minutes') },
    { value: '1800', label: t('settings.device_sync.interval_30m', 'Every 30 minutes') },
    { value: '3600', label: t('settings.device_sync.interval_1h', 'Every hour') },
    { value: '21600', label: t('settings.device_sync.interval_6h', 'Every 6 hours') },
    { value: '0', label: t('settings.device_sync.interval_manual', 'No regular sync') },
  ];

  const writableSelected = (collections ?? []).filter((col) => !col.readOnly && selectedKeys?.includes(col.key));
  const newContactsOptions = [
    { value: '', label: t('settings.device_sync.new_contacts_default', 'Default address book') },
    ...writableSelected.map((col) => ({
      value: col.key,
      label: col.isPersonal ? col.name : nameWithAccount(col.name, col.accountName),
    })),
  ];
  const newContactsValue = entry.newContactsAddressBook && newContactsOptions.some((o) => o.value === entry.newContactsAddressBook)
    ? entry.newContactsAddressBook
    : '';

  const collectionsDescription = collections && selectedKeys
    ? t('settings.device_sync.collections_count', '{selected, plural, one {# of {total} syncs} other {# of {total} sync}}', {
      selected: selectedKeys.length,
      total: collections.length,
    })
    : isContacts
      ? t('settings.device_sync.books_default', 'Your own address books sync; shared ones only when you pick them.')
      : t('settings.device_sync.calendars_default', 'Your own calendars sync; shared ones only when you pick them.');

  const statusStyle = status.tone === 'error' ? styles.statusError : status.tone === 'warning' ? styles.statusWarning : styles.statusMuted;
  const busyText = busy === 'on'
    ? t('settings.device_sync.turning_on', 'Setting up…')
    : busy === 'off'
      ? t('settings.device_sync.turning_off', 'Uploading changes, then removing the data from this device…')
      : null;

  return (
    <View style={styles.block}>
      <SettingItem label={accountLabel} description={busyText ?? undefined} noBorder>
        <View style={styles.row}>
          {(busy === 'on' || busy === 'off') && <ActivityIndicator size="small" color={c.primary} />}
          <ToggleSwitch
            checked={checked}
            onChange={(next) => {
              if (next) void startTurnOn();
              else void turnOff(false);
            }}
            disabled={busy !== null}
            accessibilityLabel={t('settings.device_sync.switch_label', 'Sync {account} to this device', { account: accountLabel })}
          />
        </View>
      </SettingItem>

      {!busyText && (
        <View style={styles.statusRow} accessibilityRole={status.tone === 'error' ? 'alert' : undefined}>
          {status.tone === 'error' && <XCircle size={14} color={c.error} />}
          {status.tone === 'warning' && <AlertTriangle size={14} color={c.warning} />}
          <Text style={[styles.statusText, statusStyle]}>{status.text}</Text>
        </View>
      )}
      {!busyText && status.action && (
        <View style={styles.actions}>
          <Button variant="outline" size="sm" onPress={() => runAction(status.action!)}>
            {status.action === 'signIn'
              ? t('settings.device_sync.sign_in_again', 'Sign in again')
              : status.action === 'grantAccess'
                ? t('settings.device_sync.grant_access', 'Grant access')
                : t('settings.device_sync.review_deletions', 'Review deletions')}
          </Button>
        </View>
      )}
      {showDetails && view && !view.masterAutomatic && (
        <Text style={[styles.statusText, styles.statusWarning]}>
          {t(
            'settings.device_sync.master_off',
            'Auto-sync is off on this device, so syncs only run when you tap Sync now.',
          )}
        </Text>
      )}

      {showDetails && (
        <View style={styles.details}>
          <SettingItem
            label={isContacts
              ? t('settings.device_sync.books_label', 'Address books')
              : t('settings.device_sync.calendars_label', 'Calendars')}
            description={collectionsDescription}
          >
            <Button variant="outline" size="sm" onPress={() => setChooserOpen(true)}>
              {t('settings.device_sync.choose', 'Choose')}
            </Button>
          </SettingItem>

          {isContacts ? (
            <SettingItem
              label={t('settings.device_sync.new_contacts_label', 'New contacts go to')}
              description={t(
                'settings.device_sync.new_contacts_desc',
                'The address book for contacts created in other apps on this device.',
              )}
            >
              <Select
                value={newContactsValue}
                onChange={(v) => useDeviceSyncStore.getState().setNewContactsAddressBook(account.id, v || null)}
                options={newContactsOptions}
              />
            </SettingItem>
          ) : (
            <SettingItem
              label={t('settings.device_sync.reminders_label', 'Reminders')}
              description={entry.reminderOwner === 'bulwark' && !calendarReminders
                ? t(
                  'settings.device_sync.reminders_nobody',
                  "Bulwark's event notifications are off, so nothing reminds you of synced events.",
                )
                : t(
                  'settings.device_sync.reminders_desc',
                  'Who reminds you of synced events. The other stays quiet, so you are not reminded twice.',
                )}
            >
              <RadioGroup
                value={entry.reminderOwner ?? 'device'}
                onChange={(v) => { void changeReminderOwner(account.id, v === 'bulwark' ? 'bulwark' : 'device'); }}
                options={[
                  { value: 'device', label: t('settings.device_sync.reminder_owner_device', 'Calendar app') },
                  { value: 'bulwark', label: t('settings.device_sync.reminder_owner_bulwark', 'Bulwark') },
                ]}
              />
            </SettingItem>
          )}

          <SettingItem
            label={t('settings.device_sync.interval_label', 'Sync interval')}
            description={t(
              'settings.device_sync.interval_desc',
              'How often Android syncs on its own. Edits in Bulwark and pushed changes sync sooner.',
            )}
            noBorder
          >
            <Select
              value={String(intervalFor(entry, authority))}
              onChange={(v) => { void changeSyncInterval(account.id, authority, Number(v)); }}
              options={intervalOptions}
            />
          </SettingItem>

          <View style={styles.actions}>
            <Button
              variant="outline"
              size="sm"
              onPress={() => { void handleSyncNow(); }}
              disabled={busy !== null || !checked}
              loading={busy === 'sync'}
              icon={<RefreshCw size={14} color={c.text} />}
            >
              {t('settings.device_sync.sync_now', 'Sync now')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onPress={() => { void openAndroidAccountSettings(account.id); }}
              disabled={!view?.exists}
              icon={<SettingsIcon size={14} color={c.text} />}
            >
              {t('settings.device_sync.android_settings', 'Android account settings')}
            </Button>
          </View>
        </View>
      )}

      <DeviceSyncCollectionsSheet
        visible={chooserOpen}
        onClose={closeChooser}
        registryId={account.id}
        authority={authority}
        accountLabel={accountLabel}
      />

      <Dialog
        visible={prompt?.kind === 'rationale'}
        title={isContacts
          ? t('settings.device_sync.rationale_title_contacts', 'Allow access to contacts')
          : t('settings.device_sync.rationale_title_calendar', 'Allow access to calendars')}
        message={isContacts
          ? t(
            'settings.device_sync.rationale_contacts',
            'To show your address books in the Contacts app, Bulwark needs access to the contacts on this device. It only changes the contacts of its own account.',
          )
          : t(
            'settings.device_sync.rationale_calendar',
            'To show your calendars in the Calendar app, Bulwark needs access to the calendars on this device. It only changes the calendars of its own account.',
          )}
        confirmText={t('settings.device_sync.continue', 'Continue')}
        onConfirm={() => { void turnOn(); }}
        onCancel={() => setPrompt(null)}
      />

      <Dialog
        visible={prompt?.kind === 'blocked'}
        title={t('settings.device_sync.blocked_title', 'Access is turned off')}
        message={isContacts
          ? t(
            'settings.device_sync.blocked_contacts',
            "Android no longer asks for access to contacts. Allow it in the app's settings, then turn sync on again.",
          )
          : t(
            'settings.device_sync.blocked_calendar',
            "Android no longer asks for access to calendars. Allow it in the app's settings, then turn sync on again.",
          )}
        confirmText={t('settings.device_sync.open_app_settings', 'Open app settings')}
        onConfirm={() => {
          setPrompt(null);
          void openAppSystemSettings();
        }}
        onCancel={() => setPrompt(null)}
      />

      <Dialog
        visible={prompt?.kind === 'pending'}
        variant="destructive"
        title={t('settings.device_sync.turn_off_title', 'Turn off anyway?')}
        message={prompt?.kind === 'pending' && prompt.pending > 0
          ? t(
            'settings.device_sync.turn_off_pending',
            "{count, plural, one {# change made on this device hasn't reached the server yet. It is lost if you turn sync off now.} other {# changes made on this device haven't reached the server yet. They are lost if you turn sync off now.}}",
            { count: prompt.pending },
          )
          : t(
            'settings.device_sync.turn_off_unknown',
            'Bulwark could not check whether changes made on this device reached the server. They are lost if you turn sync off now.',
          )}
        confirmText={t('settings.device_sync.turn_off_anyway', 'Turn off')}
        cancelText={t('settings.device_sync.keep_syncing', 'Keep syncing')}
        onConfirm={() => { void turnOff(true); }}
        onCancel={() => { void keepSyncing(); }}
      />
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    block: {
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingBottom: spacing.md,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    statusRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
    statusText: { ...typography.caption, flexShrink: 1 },
    statusMuted: { color: c.mutedForeground },
    statusWarning: { color: c.warning },
    statusError: { color: c.error },
    details: {
      marginTop: spacing.sm,
      marginStart: spacing.sm,
      paddingStart: spacing.md,
      borderStartWidth: 2,
      borderStartColor: c.muted,
    },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  });
}
