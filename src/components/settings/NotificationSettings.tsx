import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react-native';
import Button from '../Button';
import Dialog from '../Dialog';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useAuthStore } from '../../stores/auth-store';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import {
  DEFAULT_RELAY_BASE_URL,
  disablePushForAccount,
  getStoredRelayBaseUrl,
  isPushEnabledForAccount,
  isPushSupported,
  isValidRelayUrl,
  listPushDevices,
  PushSetupError,
  readPushAccountIds,
  revokePushDevice,
  setStoredRelayBaseUrl,
  setupPushNotifications,
  getStoredPushTransport,
  setStoredPushTransport,
  type PushDevice,
  type PushSetupPhase,
  type PushTransport,
} from '../../lib/push-notifications';
import {
  getSavedUnifiedPushDistributor,
  getUnifiedPushDistributors,
  isUnifiedPushSupported,
  saveUnifiedPushDistributor,
} from '../../lib/unified-push';

type PushStatus =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'enabled' }
  | { kind: 'error'; message: string };

type DevicesState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; devices: PushDevice[] }
  | { kind: 'error' };

const PHASE_KEYS: Record<PushSetupPhase, { key: string; fallback: string }> = {
  platform: { key: 'settings.notifications.push.phase_platform', fallback: 'Platform' },
  permission: { key: 'settings.notifications.push.phase_permission', fallback: 'Notification permission' },
  token: { key: 'settings.notifications.push.phase_token', fallback: 'Device token' },
  distributor: { key: 'settings.notifications.push.phase_distributor', fallback: 'UnifiedPush distributor' },
  account: { key: 'settings.notifications.push.phase_account', fallback: 'Account' },
  relay: { key: 'settings.notifications.push.phase_relay', fallback: 'Relay registration' },
  jmap: { key: 'settings.notifications.push.phase_jmap', fallback: 'Mail server subscription' },
  verify: { key: 'settings.notifications.push.phase_verify', fallback: 'Verification' },
};

export function NotificationSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const username = useAuthStore((s) => s.username);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const client = useAuthStore((s) => s.client);

  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const update = useSettingsStore((s) => s.updateSetting);
  const emailEnabled = useSettingsStore((s) => s.emailNotificationsEnabled);
  const calEnabled = useSettingsStore((s) => s.calendarNotificationsEnabled);
  const invitationParsing = useSettingsStore((s) => s.calendarInvitationParsingEnabled);

  const supported = isPushSupported();
  const upSupported = isUnifiedPushSupported();
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_BASE_URL);
  const [transport, setTransport] = useState<PushTransport>('fcm');
  const [distributors, setDistributors] = useState<string[]>([]);
  const [savedDistributor, setSavedDistributor] = useState<string | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushStatus, setPushStatus] = useState<PushStatus>({ kind: 'idle' });
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [devices, setDevices] = useState<DevicesState>({ kind: 'idle' });
  const [revokeTarget, setRevokeTarget] = useState<PushDevice | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await getStoredRelayBaseUrl();
      const enabled = activeAccountId ? await isPushEnabledForAccount(activeAccountId) : false;
      if (cancelled) return;
      if (stored) setRelayUrl(stored);
      setPushEnabled(enabled);
      setPushStatus(enabled ? { kind: 'enabled' } : { kind: 'idle' });
      const storedTransport = await getStoredPushTransport();
      const upDistributors = upSupported ? await getUnifiedPushDistributors() : [];
      const upSaved = upSupported ? await getSavedUnifiedPushDistributor() : null;
      if (cancelled) return;
      setTransport(storedTransport ?? 'fcm');
      setDistributors(upDistributors);
      setSavedDistributor(upSaved);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccountId]);

  const trimmed = relayUrl.trim().replace(/\/+$/, '');
  const relayValid = isValidRelayUrl(trimmed);
  const busy = pushStatus.kind === 'busy';

  const refreshDevices = useCallback(async () => {
    if (!activeAccountId || !client) return;
    setDevices({ kind: 'loading' });
    try {
      const list = await listPushDevices({ accountId: activeAccountId, relayBaseUrl: trimmed });
      setDevices({ kind: 'loaded', devices: list });
    } catch {
      setDevices({ kind: 'error' });
    }
  }, [activeAccountId, client, trimmed]);

  useEffect(() => {
    if (!supported) return;
    void refreshDevices();
    // Only on mount / account change - the relay URL field should not refetch
    // on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccountId, supported]);

  const describeError = (error: unknown): string => {
    if (error instanceof PushSetupError) {
      const phase = PHASE_KEYS[error.phase];
      return `${t(phase.key, phase.fallback)}: ${error.message}`;
    }
    return error instanceof Error ? error.message : t('settings.notifications.push.setup_failed', 'Setup failed');
  };

  const handleEnable = async (forceRecreate = false) => {
    if (!relayValid) {
      setPushStatus({
        kind: 'error',
        message: t('settings.notifications.push.relay_invalid', 'Enter a valid https:// URL'),
      });
      return;
    }
    setPushStatus({
      kind: 'busy',
      message: t('settings.notifications.push.status_busy', 'Working…'),
    });
    try {
      await setStoredRelayBaseUrl(trimmed);
      await setupPushNotifications({
        relayBaseUrl: trimmed,
        accountLabel: username ?? undefined,
        forceRecreate,
      });
      setPushEnabled(true);
      setPushStatus({ kind: 'enabled' });
    } catch (error) {
      setPushStatus({ kind: 'error', message: describeError(error) });
    } finally {
      void refreshDevices();
    }
  };

  // Switching the transport while push is on re-registers immediately so the
  // relay record flips to the new delivery path; while off it just records
  // the preference for the next enable.
  const handleSelectTransport = async (next: PushTransport) => {
    if (next === transport || busy) return;
    setTransport(next);
    await setStoredPushTransport(next);
    if (pushEnabled) void handleEnable(true);
  };

  const handleSelectDistributor = async (distributor: string) => {
    if (distributor === savedDistributor || busy) return;
    setSavedDistributor(distributor);
    try {
      await saveUnifiedPushDistributor(distributor);
    } catch {
      return;
    }
    if (pushEnabled && transport === 'unifiedpush') void handleEnable(true);
  };

  const performDisable = async () => {
    setConfirmDisable(false);
    setPushStatus({
      kind: 'busy',
      message: t('settings.notifications.push.status_busy', 'Working…'),
    });
    try {
      if (activeAccountId) {
        await disablePushForAccount(activeAccountId);
      }
      // The relay base URL is a device-wide setting shared with any other
      // accounts that are still using push. Only clear it when no accounts
      // are using push any more.
      const remaining = await readPushAccountIds();
      if (remaining.length === 0) {
        await setStoredRelayBaseUrl(null);
        setRelayUrl(DEFAULT_RELAY_BASE_URL);
      }
      setPushEnabled(false);
      setPushStatus({ kind: 'idle' });
    } catch (error) {
      setPushStatus({ kind: 'error', message: describeError(error) });
    } finally {
      void refreshDevices();
    }
  };

  const performRevoke = async () => {
    const device = revokeTarget;
    setRevokeTarget(null);
    if (!device || !activeAccountId) return;
    setRevokingId(device.id);
    try {
      await revokePushDevice({ accountId: activeAccountId, device, relayBaseUrl: trimmed });
      if (device.isThisDevice) {
        setPushEnabled(false);
        setPushStatus({ kind: 'idle' });
      }
    } catch (error) {
      setPushStatus({ kind: 'error', message: describeError(error) });
    } finally {
      setRevokingId(null);
      void refreshDevices();
    }
  };

  const relayStatusLabel = (status: PushDevice['relayStatus']) => {
    if (status === 'active') return t('settings.notifications.push.device_status_active', 'Delivering notifications');
    if (status === 'inactive') return t('settings.notifications.push.device_status_inactive', 'Never delivered a notification');
    return t('settings.notifications.push.device_status_unknown', 'Not known to this relay');
  };

  const statusDescription = !supported
    ? t('settings.notifications.push.status_android_only', 'Background notifications are available on Android only.')
    : pushStatus.kind === 'enabled'
      ? t('settings.notifications.push.status_active', 'Active on this device')
      : pushStatus.kind === 'busy'
        ? pushStatus.message
        : t('settings.notifications.push.status_inactive', 'Not enabled on this device');

  return (
    <View style={styles.container}>
      <SettingsSection
        title={t('settings.notifications.push.title', 'Background Notifications')}
        description={t(
          'settings.notifications.push.description_mobile',
          'Receive system notifications for new mail when the app is closed. Delivered via the Bulwark push relay; the relay never sees mail content.',
        )}
      >
        <SettingItem label={t('settings.notifications.push.enable', 'Enable')} description={statusDescription}>
          <View style={styles.row}>
            {pushStatus.kind === 'busy' && <ActivityIndicator size="small" color={c.primary} />}
            {pushStatus.kind === 'enabled' && <CheckCircle2 size={16} color={c.success} />}
            <ToggleSwitch
              checked={pushEnabled}
              onChange={(checked) => {
                if (checked) void handleEnable();
                else setConfirmDisable(true);
              }}
              disabled={!supported || busy || !client}
            />
          </View>
        </SettingItem>

        {upSupported && (
          <>
            <SettingItem
              label={t('settings.notifications.push.transport_label', 'Delivery method')}
              description={t(
                'settings.notifications.push.transport_desc',
                'How notifications reach this device: Google’s Firebase Cloud Messaging, or a UnifiedPush distributor app (such as ntfy) for Google-free delivery.',
              )}
            >
              <View style={styles.row}>
                <Button
                  variant={transport === 'fcm' ? 'default' : 'outline'}
                  size="sm"
                  onPress={() => void handleSelectTransport('fcm')}
                  disabled={busy}
                >
                  {t('settings.notifications.push.transport_fcm', 'Google (FCM)')}
                </Button>
                <Button
                  variant={transport === 'unifiedpush' ? 'default' : 'outline'}
                  size="sm"
                  onPress={() => void handleSelectTransport('unifiedpush')}
                  disabled={busy}
                >
                  {t('settings.notifications.push.transport_unifiedpush', 'UnifiedPush')}
                </Button>
              </View>
            </SettingItem>
            {transport === 'unifiedpush' && distributors.length === 0 && (
              <Text style={styles.errorText}>
                {t(
                  'settings.notifications.push.up_no_distributor',
                  'No UnifiedPush distributor app is installed on this device. Install one (for example ntfy) and try again.',
                )}
              </Text>
            )}
            {transport === 'unifiedpush' && distributors.length > 1 && (
              <SettingItem
                label={t('settings.notifications.push.up_distributor_label', 'Distributor')}
                description={t(
                  'settings.notifications.push.up_distributor_desc',
                  'Several UnifiedPush distributor apps are installed - pick the one that should deliver notifications.',
                )}
              >
                <View style={styles.distributorList}>
                  {distributors.map((d) => (
                    <Button
                      key={d}
                      variant={d === savedDistributor ? 'default' : 'outline'}
                      size="sm"
                      onPress={() => void handleSelectDistributor(d)}
                      disabled={busy}
                    >
                      {d}
                    </Button>
                  ))}
                </View>
              </SettingItem>
            )}
          </>
        )}

        <SettingItem
          label={t('settings.notifications.push.relay_label', 'Push relay')}
          description={t(
            'settings.notifications.push.relay_desc_mobile',
            'The server that delivers your notifications. Defaults to the hosted Bulwark relay; change only if you self-host. Must use https.',
          )}
          noBorder
        >
          <View />
        </SettingItem>
        <TextInput
          value={relayUrl}
          onChangeText={setRelayUrl}
          placeholder={DEFAULT_RELAY_BASE_URL}
          placeholderTextColor={c.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={supported && !busy}
          accessibilityLabel={t('settings.notifications.push.relay_label', 'Push relay')}
          style={[styles.urlInput, !relayValid && styles.urlInputInvalid]}
        />
        {!relayValid && (
          <Text style={styles.errorText}>
            {t('settings.notifications.push.relay_invalid', 'Enter a valid https:// URL')}
          </Text>
        )}
        {pushEnabled && (
          <View style={styles.actions}>
            <Button
              variant="outline"
              size="sm"
              onPress={() => void handleEnable(true)}
              disabled={!supported || busy || !relayValid}
            >
              {t('settings.notifications.push.reenable', 'Re-register')}
            </Button>
          </View>
        )}
        {pushStatus.kind === 'error' && (
          <View style={styles.errorRow} accessibilityRole="alert">
            <XCircle size={14} color={c.error} />
            <Text style={[styles.errorText, { flex: 1 }]}>{pushStatus.message}</Text>
          </View>
        )}
      </SettingsSection>

      {supported && client && (
        <SettingsSection
          title={t('settings.notifications.push.devices_title', 'Registered devices')}
          description={t(
            'settings.notifications.push.devices_desc',
            'Every device registered to receive background notifications for this account. Revoking one stops it receiving immediately.',
          )}
        >
          <View style={styles.devicesHeader}>
            <Text style={styles.fieldDescription}>
              {devices.kind === 'loading' && t('settings.notifications.push.devices_loading', 'Loading registered devices…')}
              {devices.kind === 'error' && t('settings.notifications.push.devices_error', 'Could not load registered devices.')}
              {devices.kind === 'loaded' && devices.devices.length === 0
                && t('settings.notifications.push.devices_empty', 'No devices are registered for background notifications.')}
            </Text>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => void refreshDevices()}
              disabled={devices.kind === 'loading'}
              icon={<RefreshCw size={14} color={c.text} />}
            >
              {t('settings.notifications.push.devices_refresh', 'Refresh')}
            </Button>
          </View>
          {devices.kind === 'loaded' && devices.devices.length > 0 && (
            <View style={styles.deviceList}>
              {devices.devices.map((device, index) => (
                <View
                  key={device.id}
                  style={[styles.deviceRow, index > 0 && styles.deviceRowBorder]}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.deviceTitle} numberOfLines={1}>
                      {device.isThisDevice
                        ? t('settings.notifications.push.device_this', 'This device')
                        : t('settings.notifications.push.device_other', 'Other device')}
                      <Text style={styles.deviceId}>  {device.deviceClientId.slice(0, 8)}</Text>
                    </Text>
                    <Text style={styles.fieldDescription}>
                      {relayStatusLabel(device.relayStatus)}
                      {device.expires
                        ? ` · ${t('settings.notifications.push.device_expires', 'Expires {date}', {
                          date: new Date(device.expires).toLocaleDateString(),
                        })}`
                        : ''}
                    </Text>
                  </View>
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => setRevokeTarget(device)}
                    disabled={revokingId !== null}
                    loading={revokingId === device.id}
                  >
                    {t('settings.notifications.push.revoke', 'Revoke')}
                  </Button>
                </View>
              ))}
            </View>
          )}
        </SettingsSection>
      )}

      <SettingsSection
        title={t('settings.notifications.email.title', 'Email Notifications')}
        description={t('settings.notifications.email.description', 'Configure notifications for incoming emails')}
      >
        <SettingItem
          label={t('settings.notifications.email.enabled', 'Email notifications')}
          description={t('settings.notifications.email.enabled_desc', 'Show notifications when new emails arrive')}
        >
          <ToggleSwitch checked={emailEnabled} onChange={(v) => update('emailNotificationsEnabled', v)} />
        </SettingItem>
        {Platform.OS === 'android' && (
          <Text style={styles.fieldDescription}>
            {t(
              'settings.notifications.email.sound_channel_hint',
              'Sound and vibration for mail alerts are controlled by the Android notification channel: long-press a notification or open the system app settings.',
            )}
          </Text>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.notifications.calendar.title', 'Calendar Notifications')}
        description={t('settings.notifications.calendar.description', 'Configure notifications for calendar events')}
      >
        <SettingItem
          label={t('settings.notifications.calendar.enabled', 'Event notifications')}
          description={t('settings.notifications.calendar.enabled_desc', 'Show alerts for upcoming calendar events')}
        >
          <ToggleSwitch checked={calEnabled} onChange={(v) => update('calendarNotificationsEnabled', v)} />
        </SettingItem>
        <SettingItem
          label={t('settings.notifications.calendar.invitation_parsing', 'Parse email invitations')}
          description={t(
            'settings.notifications.calendar.invitation_parsing_desc',
            'Detect calendar invitations in email attachments and show calendar actions',
          )}
        >
          <ToggleSwitch
            checked={invitationParsing}
            onChange={(v) => update('calendarInvitationParsingEnabled', v)}
          />
        </SettingItem>
      </SettingsSection>

      <Dialog
        visible={confirmDisable}
        variant="destructive"
        title={t('settings.notifications.push.confirm_disable_title', 'Disable background notifications?')}
        message={t(
          'settings.notifications.push.confirm_disable_message_mobile',
          'This device will stop receiving new-mail alerts for this account.',
        )}
        confirmText={t('settings.notifications.push.disable', 'Disable')}
        onCancel={() => setConfirmDisable(false)}
        onConfirm={performDisable}
      />
      <Dialog
        visible={revokeTarget !== null}
        variant="destructive"
        title={t('settings.notifications.push.confirm_revoke_title', 'Revoke this device?')}
        message={
          revokeTarget?.isThisDevice
            ? t(
              'settings.notifications.push.confirm_revoke_message_this',
              'This device will stop receiving background notifications immediately.',
            )
            : t(
              'settings.notifications.push.confirm_revoke_message',
              'It will stop receiving background notifications immediately. Enabling push again on that device registers it anew.',
            )
        }
        confirmText={t('settings.notifications.push.revoke', 'Revoke')}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={performRevoke}
      />
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { gap: spacing.xxxl },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    fieldDescription: {
      ...typography.caption,
      color: c.mutedForeground,
      flexShrink: 1,
    },
    urlInput: {
      ...typography.body,
      color: c.text,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: 8,
      alignSelf: 'stretch',
    },
    urlInputInvalid: { borderColor: c.error },
    distributorList: { flexDirection: 'column', alignItems: 'flex-end', gap: spacing.sm },
    errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: spacing.sm },
    errorText: { ...typography.caption, color: c.error },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
    devicesHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    deviceList: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
    },
    deviceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
    },
    deviceRowBorder: { borderTopWidth: 1, borderTopColor: c.border },
    deviceTitle: { ...typography.bodyMedium, color: c.text },
    deviceId: { ...typography.caption, color: c.mutedForeground, fontWeight: '400' },
  });
}
