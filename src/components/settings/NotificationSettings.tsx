import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CheckCircle2, Volume2, XCircle } from 'lucide-react-native';
import Button from '../Button';
import Dialog from '../Dialog';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useAuthStore } from '../../stores/auth-store';
import { useSettingsStore, type NotificationSound } from '../../stores/settings-store';
import {
  DEFAULT_RELAY_BASE_URL,
  getStoredRelayBaseUrl,
  readPushAccountIds,
  setStoredRelayBaseUrl,
  setupPushNotifications,
  teardownPushNotificationsForAccount,
} from '../../lib/push-notifications';

const SOUNDS: { value: NotificationSound; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'chime', label: 'Chime' },
  { value: 'ping', label: 'Ping' },
  { value: 'pop', label: 'Pop' },
  { value: 'none', label: 'Silent' },
];

type PushStatus =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'enabled' }
  | { kind: 'error'; message: string };

export function NotificationSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const username = useAuthStore((s) => s.username);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);

  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const update = useSettingsStore((s) => s.updateSetting);
  const sound = useSettingsStore((s) => s.notificationSoundChoice);
  const emailEnabled = useSettingsStore((s) => s.emailNotificationsEnabled);
  const emailSound = useSettingsStore((s) => s.emailNotificationSound);
  const calEnabled = useSettingsStore((s) => s.calendarNotificationsEnabled);
  const calSound = useSettingsStore((s) => s.calendarNotificationSound);
  const invitationParsing = useSettingsStore((s) => s.calendarInvitationParsingEnabled);

  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_BASE_URL);
  const [hasSaved, setHasSaved] = useState(false);
  const [pushStatus, setPushStatus] = useState<PushStatus>({ kind: 'idle' });
  const [confirmDisable, setConfirmDisable] = useState(false);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  useEffect(() => {
    void (async () => {
      const stored = await getStoredRelayBaseUrl();
      if (stored) {
        setRelayUrl(stored);
        setHasSaved(true);
        setPushStatus({ kind: 'enabled' });
      }
    })();
  }, []);

  const trimmed = relayUrl.trim().replace(/\/+$/, '');
  const isValidUrl = /^https?:\/\/.+/i.test(trimmed);
  const busy = pushStatus.kind === 'busy';
  const canEnable = isValidUrl && !busy;

  const handleEnable = async () => {
    if (!isValidUrl) {
      setPushStatus({ kind: 'error', message: 'Enter a valid https:// URL' });
      return;
    }
    setPushStatus({ kind: 'busy', message: 'Registering device…' });
    try {
      await setStoredRelayBaseUrl(trimmed);
      await setupPushNotifications({
        relayBaseUrl: trimmed,
        accountLabel: username ?? undefined,
      });
      setHasSaved(true);
      setPushStatus({ kind: 'enabled' });
    } catch (error) {
      setPushStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Setup failed',
      });
    }
  };

  const handleDisable = () => {
    setConfirmDisable(true);
  };

  const performDisable = async () => {
    setConfirmDisable(false);
    setPushStatus({ kind: 'busy', message: 'Disabling…' });
    try {
      if (activeAccountId) {
        await teardownPushNotificationsForAccount(activeAccountId);
      }
      // The relay base URL is a device-wide setting shared with any other
      // accounts that are still using push. Only clear it (and reset the UI
      // to "not configured") when no accounts are using push any more —
      // otherwise the remaining accounts would lose their relay URL and
      // their next setup attempt would no-op.
      const remaining = await readPushAccountIds();
      if (remaining.length === 0) {
        await setStoredRelayBaseUrl(null);
        setRelayUrl(DEFAULT_RELAY_BASE_URL);
        setHasSaved(false);
      }
      setPushStatus({ kind: 'idle' });
    } catch (error) {
      setPushStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Teardown failed',
      });
    }
  };

  return (
    <View style={styles.container}>
      <SettingsSection
        title="Push Notifications"
        description="Delivered via the Bulwark push relay. The relay only sees an opaque token and new-mail timing - never mail content."
      >
        <View style={styles.pushCard}>
          <View style={styles.pushHeader}>
            <Text style={styles.fieldLabel}>Relay base URL</Text>
            <View style={styles.statusRow}>
              {pushStatus.kind === 'busy' && (
                <>
                  <ActivityIndicator size="small" color={c.primary} />
                  <Text style={styles.statusText}>{pushStatus.message}</Text>
                </>
              )}
              {pushStatus.kind === 'enabled' && (
                <>
                  <CheckCircle2 size={14} color={c.success} />
                  <Text style={[styles.statusText, { color: c.success }]}>Active</Text>
                </>
              )}
              {pushStatus.kind === 'error' && (
                <>
                  <XCircle size={14} color={c.error} />
                  <Text style={[styles.statusText, { color: c.error }]}>
                    {pushStatus.message}
                  </Text>
                </>
              )}
              {pushStatus.kind === 'idle' && (
                <Text style={[styles.statusText, { color: c.mutedForeground }]}>
                  Not configured
                </Text>
              )}
            </View>
          </View>
          <Text style={styles.fieldDescription}>
            Defaults to the hosted Bulwark relay. Change only if you self-host.
          </Text>
          <TextInput
            value={relayUrl}
            onChangeText={setRelayUrl}
            placeholder={DEFAULT_RELAY_BASE_URL}
            placeholderTextColor={c.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!busy}
            style={styles.urlInput}
          />
          <View style={styles.actions}>
            <Button
              variant="default"
              onPress={handleEnable}
              disabled={!canEnable}
              loading={busy}
            >
              {hasSaved ? 'Re-register' : 'Enable'}
            </Button>
            {hasSaved && (
              <Button variant="outline" onPress={handleDisable} disabled={busy}>
                Disable
              </Button>
            )}
          </View>
        </View>
      </SettingsSection>

      <SettingsSection title="Sound Selection" description="Pick the sound used for new notifications.">
        <SettingItem label="Notification Sound" description="Played when a new notification arrives.">
          <View style={styles.row}>
            <Button
              variant="ghost"
              size="icon"
              icon={<Volume2 size={16} color={c.text} />}
            />
            <Select
              value={sound}
              onChange={(v) => update('notificationSoundChoice', v as NotificationSound)}
              options={SOUNDS}
            />
          </View>
        </SettingItem>
      </SettingsSection>

      <SettingsSection title="Email" description="Notifications for incoming email.">
        <SettingItem label="Email Notifications" description="Show desktop alerts for new email.">
          <ToggleSwitch checked={emailEnabled} onChange={(v) => update('emailNotificationsEnabled', v)} />
        </SettingItem>
        <SettingItem label="Email Sound" description="Play a sound when new email arrives.">
          <ToggleSwitch
            checked={emailSound}
            onChange={(v) => update('emailNotificationSound', v)}
            disabled={!emailEnabled}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title="Calendar" description="Notifications for events and invitations.">
        <SettingItem label="Calendar Notifications" description="Show alerts for upcoming events.">
          <ToggleSwitch checked={calEnabled} onChange={(v) => update('calendarNotificationsEnabled', v)} />
        </SettingItem>
        <SettingItem label="Calendar Sound" description="Play a sound for calendar alerts.">
          <ToggleSwitch
            checked={calSound}
            onChange={(v) => update('calendarNotificationSound', v)}
            disabled={!calEnabled}
          />
        </SettingItem>
        <SettingItem label="Invitation Parsing" description="Automatically detect and parse event invitations.">
          <ToggleSwitch
            checked={invitationParsing}
            onChange={(v) => update('calendarInvitationParsingEnabled', v)}
          />
        </SettingItem>
      </SettingsSection>

      <Dialog
        visible={confirmDisable}
        variant="destructive"
        title="Disable push notifications?"
        message="The device will stop receiving new-mail alerts from this server."
        confirmText="Disable"
        cancelText="Cancel"
        onCancel={() => setConfirmDisable(false)}
        onConfirm={performDisable}
      />
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { gap: spacing.xxxl },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pushCard: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  pushHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  fieldLabel: {
    ...typography.bodyMedium,
    color: c.text,
  },
  fieldDescription: {
    ...typography.caption,
    color: c.mutedForeground,
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
    marginTop: 4,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  statusText: { ...typography.caption, color: c.text },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
});
}
