import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import Button from '../Button';
import Dialog from '../Dialog';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { distinctAccountLabels } from '../../lib/account-labels';
import { syncSectionView } from '../../lib/settings-sync';
import { useAccountStore } from '../../stores/account-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { usePolicyFeature } from '../../stores/policy-store';
import { useOfflineCacheStore } from '../../stores/offline-cache-store';
import { useOutboxStore } from '../../stores/outbox-store';
import { runOfflineSync, formatBytes } from '../../lib/offline-sync';
import { useSettingsSyncStore } from '../../stores/settings-sync-store';

interface StorageSettingsProps {
  /** Opens Troubleshooting (refresh cached data, debug logging). */
  onOpenTroubleshooting?: () => void;
}

/** Settings → Storage & backup: offline mail, settings sync, settings export/import, reset. */
export function StorageSettings({ onOpenTroubleshooting }: StorageSettingsProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const resetToDefaults = useSettingsStore((s) => s.resetToDefaults);
  const exportSettings = useSettingsStore((s) => s.exportSettings);
  const importSettings = useSettingsStore((s) => s.importSettings);
  // The organisation can turn settings export and import off (webmail
  // about-data-settings.tsx).
  const exportAllowed = usePolicyFeature('settingsExportEnabled');

  const [confirmReset, setConfirmReset] = useState(false);
  // With the settings in the account, a reset reaches the other devices too.
  const settingsSyncEnabled = useSettingsStore((s) => s.settingsSyncEnabled);
  // Also while the account can't be reached: the reset goes out once it can.
  const settingsHeld = useSettingsSyncStore((s) => s.accountId !== null && s.status !== 'unsupported' && s.status !== 'signed-out');
  const resetEverywhere = settingsSyncEnabled && settingsHeld;

  const offlineEnabled = useSettingsStore((s) => s.offlineCacheEnabled);
  const offlineDays = useSettingsStore((s) => s.offlineCacheDays);
  const offlineMaxMB = useSettingsStore((s) => s.offlineCacheMaxMB);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const queuedChanges = useOutboxStore((s) => s.entries.length);
  const flushOutbox = useOutboxStore((s) => s.flush);
  const cacheCount = useOfflineCacheStore((s) => s.totalCount());
  const cacheBytes = useOfflineCacheStore((s) => s.totalSize());
  const cacheHydrated = useOfflineCacheStore((s) => s.hydrated);
  const cacheHydrate = useOfflineCacheStore((s) => s.hydrate);
  const sync = useOfflineCacheStore((s) => s.sync);
  const clearAllCache = useOfflineCacheStore((s) => s.clearAll);
  const syncBusy = sync.phase === 'scanning' || sync.phase === 'fetching';

  useEffect(() => {
    if (!hydrated) void hydrate();
    if (!cacheHydrated) void cacheHydrate();
  }, [hydrated, hydrate, cacheHydrated, cacheHydrate]);

  const dayOptions = [1, 3, 7, 14, 30, 90].map((d) => ({
    value: String(d),
    label: d === 1
      ? t('settings.offline.keep_24h', '24 hours')
      : t('settings.offline.keep_days', '{count} days', { count: d }),
  }));
  const maxMbOptions = [25, 50, 100, 250, 500].map((mb) => ({ value: String(mb), label: `${mb} MB` }));

  const formatRelativeTime = (ms: number | undefined): string => {
    if (!ms) return t('settings.offline.never', 'never');
    const diff = Date.now() - ms;
    if (diff < 60_000) return t('settings.offline.just_now', 'just now');
    if (diff < 60 * 60_000) return t('settings.offline.minutes_ago', '{count} min ago', { count: Math.round(diff / 60_000) });
    if (diff < 24 * 60 * 60_000) return t('settings.offline.hours_ago', '{count} h ago', { count: Math.round(diff / (60 * 60_000)) });
    return t('settings.offline.days_ago', '{count} d ago', { count: Math.round(diff / (24 * 60 * 60_000)) });
  };

  const handleSyncNow = () => {
    void runOfflineSync({ days: offlineDays, maxMB: offlineMaxMB });
    // Also drain any queued offline changes while we're at it.
    void flushOutbox();
  };

  const handleClearCache = () => {
    Alert.alert(
      t('settings.offline.clear_title', 'Clear offline mail'),
      t(
        'settings.offline.clear_message',
        'Remove {count, plural, one {# cached message} other {# cached messages}} ({size})?',
        { count: cacheCount, size: formatBytes(cacheBytes) },
      ),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        { text: t('settings.offline.clear', 'Clear'), style: 'destructive', onPress: () => { void clearAllCache(); } },
      ],
    );
  };

  const handleReset = () => {
    setConfirmReset(false);
    resetToDefaults();
    Alert.alert(
      t('settings.advanced.reset_settings.label', 'Reset Settings'),
      t('settings.advanced.reset_settings.done', 'All settings have been restored to their defaults.'),
    );
  };

  const handleExport = async () => {
    try {
      const json = exportSettings();
      const file = new File(Paths.cache, `bulwark-settings-${new Date().toISOString().slice(0, 10)}.json`);
      file.write(json);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/json',
          dialogTitle: t('settings.advanced.export_settings.label', 'Export Settings'),
        });
      } else {
        Alert.alert(
          t('settings.advanced.export_settings.label', 'Export Settings'),
          t('settings.advanced.export_settings.saved_to', 'Saved to {path}', { path: file.uri }),
        );
      }
    } catch (err) {
      Alert.alert(
        t('settings.advanced.export_settings.label', 'Export Settings'),
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const handleImport = async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['application/json', 'text/plain', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets?.[0]) return;
      const json = await new File(picked.assets[0].uri).text();
      const ok = importSettings(json);
      Alert.alert(
        t('settings.advanced.import_settings.label', 'Import Settings'),
        ok
          ? t('settings.import_success', 'Settings imported successfully')
          : t('settings.import_error', 'Failed to import settings'),
      );
    } catch (err) {
      Alert.alert(
        t('settings.advanced.import_settings.label', 'Import Settings'),
        err instanceof Error ? err.message : t('settings.import_error', 'Failed to import settings'),
      );
    }
  };

  const usedMB = cacheBytes / (1024 * 1024);
  const usedFraction = offlineMaxMB > 0 ? Math.min(1, usedMB / offlineMaxMB) : 0;
  const syncLine = sync.phase === 'fetching'
    ? t('settings.offline.downloading', 'Downloading {completed}/{total}…', { completed: sync.completed, total: sync.total })
    : sync.phase === 'scanning'
      ? t('settings.offline.scanning', 'Scanning recent mail…')
      : sync.phase === 'error'
        ? t('settings.offline.last_sync_failed', 'Last sync failed: {message}', { message: sync.message ?? t('identities.validation_errors.unknown_error', 'Unknown error') })
        : t('settings.offline.synced', 'Synced {when}', { when: formatRelativeTime(sync.finishedAt) });

  return (
    <View style={styles.container}>
      <View style={styles.usageCard}>
        <View style={styles.usageHeader}>
          <Text style={styles.usageTitle}>
            {cacheCount === 0
              ? t('settings.offline.nothing_cached', 'Nothing cached yet')
              : t('settings.offline.messages_offline', '{count, plural, one {# message offline} other {# messages offline}}', { count: cacheCount })}
          </Text>
          <Text style={styles.usageSize}>
            {t('settings.offline.used_of', '{used} of {limit} MB', { used: usedMB.toFixed(1), limit: offlineMaxMB })}
          </Text>
        </View>
        <View
          style={styles.progressTrack}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: Math.round((syncBusy && sync.total > 0 ? sync.completed / sync.total : usedFraction) * 100) }}
        >
          <View
            style={[
              styles.progressFill,
              { width: `${Math.round((syncBusy && sync.total > 0 ? sync.completed / sync.total : usedFraction) * 100)}%` },
            ]}
          />
        </View>
        <View style={styles.usageFooter}>
          <View style={{ flex: 1 }}>
            <Text style={styles.usageSub}>{syncLine}</Text>
            {queuedChanges > 0 && (
              <Text style={styles.usageSub}>
                {t('settings.offline.queued_changes', '{count, plural, one {# change} other {# changes}} waiting to sync', { count: queuedChanges })}
              </Text>
            )}
          </View>
          <Button variant="outline" size="sm" onPress={handleSyncNow} disabled={!offlineEnabled} loading={syncBusy}>
            {t('settings.offline.sync_now', 'Sync now')}
          </Button>
          <Button variant="ghost" size="sm" onPress={handleClearCache} disabled={cacheCount === 0 || syncBusy}>
            {t('settings.offline.clear', 'Clear')}
          </Button>
        </View>
      </View>

      <SettingsSection
        title={t('settings.offline.title', 'Offline mail')}
        description={t('settings.offline.description_short', 'Keep recent messages on this device so they open without a connection.')}
      >
        <SettingItem label={t('settings.offline.enabled', 'Cache recent mail')}>
          <ToggleSwitch
            checked={offlineEnabled}
            onChange={(v) => updateSetting('offlineCacheEnabled', v)}
          />
        </SettingItem>
        <SettingItem label={t('settings.offline.keep_from', 'Keep mail from the last')}>
          <Select
            value={String(offlineDays)}
            onChange={(v) => updateSetting('offlineCacheDays', Number(v))}
            options={dayOptions}
          />
        </SettingItem>
        <SettingItem label={t('settings.offline.use_at_most', 'Use at most')} noBorder>
          <Select
            value={String(offlineMaxMB)}
            onChange={(v) => updateSetting('offlineCacheMaxMB', Number(v))}
            options={maxMbOptions}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSyncSection formatRelativeTime={formatRelativeTime} />

      <SettingsSection
        title={t('settings.backup.title', 'Settings backup')}
        description={t('settings.backup.description', 'Move your settings to another device or the webmail.')}
      >
        {exportAllowed && (
          <SettingItem
            label={t('settings.backup.export_import', 'Export or import')}
            description={t('settings.backup.export_import_desc', 'A JSON file, same format as the webmail')}
          >
            <View style={styles.buttonPair}>
              <Button variant="outline" size="sm" onPress={() => void handleExport()}>
                {t('settings.advanced.export_settings.button', 'Export')}
              </Button>
              <Button variant="outline" size="sm" onPress={() => void handleImport()}>
                {t('settings.advanced.import_settings.button', 'Import')}
              </Button>
            </View>
          </SettingItem>
        )}
        <SettingItem
          label={t('settings.advanced.reset_settings.label', 'Reset Settings')}
          description={t('settings.backup.reset_desc', 'Back to the defaults; mail stays')}
        >
          <Button variant="destructiveOutline" size="sm" onPress={() => setConfirmReset(true)}>
            {t('settings.backup.reset', 'Reset')}
          </Button>
        </SettingItem>
        <SettingItem
          label={t('settings.troubleshooting.title', 'Troubleshooting')}
          description={t('settings.troubleshooting.row_desc', 'Refresh cached data, debug logging')}
          onPress={onOpenTroubleshooting}
          noBorder
        />
      </SettingsSection>

      <Dialog
        visible={confirmReset}
        variant="destructive"
        title={t('settings.advanced.reset_settings.label', 'Reset Settings')}
        message={resetEverywhere
          ? `${t('settings.reset_confirm', 'Are you sure you want to reset all settings to defaults?')} ${t('settings.sync.reset_everywhere', 'Settings sync is on, so they are reset on your other devices too.')}`
          : t('settings.reset_confirm', 'Are you sure you want to reset all settings to defaults?')}
        confirmText={t('settings.advanced.reset_settings.button', 'Reset to Defaults')}
        onCancel={() => setConfirmReset(false)}
        onConfirm={handleReset}
      />
    </View>
  );
}

interface SettingsSyncSectionProps {
  /** "5 min ago", as the offline mail card words it. */
  formatRelativeTime: (ms: number | undefined) => string;
}

/**
 * Settings > Storage & backup > Settings sync (#117): the switch, which
 * account keeps the settings, and how the last round went.
 */
function SettingsSyncSection({ formatRelativeTime }: SettingsSyncSectionProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const enabled = useSettingsStore((s) => s.settingsSyncEnabled);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const accounts = useAccountStore((s) => s.accounts);
  const status = useSettingsSyncStore((s) => s.status);
  const picked = useSettingsStore((s) => s.settingsSyncAccountId);
  const lastSyncedAt = useSettingsSyncStore((s) => s.lastSyncedAt);
  const tooLarge = useSettingsSyncStore((s) => s.tooLarge.length);
  const replaced = useSettingsSyncStore((s) => s.replaced);
  const syncNow = useSettingsSyncStore((s) => s.syncNow);
  const keepReplaced = useSettingsSyncStore((s) => s.keepReplaced);
  const dismissReplaced = useSettingsSyncStore((s) => s.dismissReplaced);

  const labels = React.useMemo(() => distinctAccountLabels(accounts), [accounts]);
  const view = syncSectionView({ enabled, status, accountIds: accounts.map((a) => a.id), picked });
  if (!view.visible) return null;
  const accountOptions = [
    // The holder signed out: nothing is picked until the user does.
    ...(view.holder === '' ? [{ value: '', label: t('files.choose_account', 'Choose an account') }] : []),
    ...accounts.map((a) => ({ value: a.id, label: labels.get(a.id) ?? a.email })),
  ];

  const statusLine = (): string => {
    switch (status) {
      case 'signed-out':
        return t('settings.sync.status_signed_out', 'The account that kept your settings is signed out. Pick the account to keep them in.');
      case 'unsupported':
        return t('settings.sync.status_unsupported', "This account's mail server can't keep settings.");
      case 'unreachable':
        return t('settings.sync.status_unreachable', "Couldn't reach the account. It will be tried again.");
      case 'full':
        return t('settings.sync.status_full', 'The account has no room left for settings.');
      case 'synced':
        return t('settings.offline.synced', 'Synced {when}', { when: formatRelativeTime(lastSyncedAt ?? undefined) });
      default:
        return t('settings.sync.status_syncing', 'Syncing…');
    }
  };
  const replacedCount = replaced ? Object.keys(replaced).length : 0;

  return (
    <SettingsSection
      title={t('settings.sync.title', 'Settings sync')}
      description={t('settings.sync.description', 'Keep your settings in your mail account, so your other devices have the same ones.')}
    >
      <SettingItem
        label={t('settings.sync.enabled', 'Sync settings')}
        description={t('settings.sync.enabled_desc', 'Choices that fit one device, such as the reading pane and offline mail, stay on it.')}
        noBorder={!enabled}
      >
        <ToggleSwitch checked={enabled} onChange={(v) => updateSetting('settingsSyncEnabled', v)} />
      </SettingItem>
      {view.showPicker && (
        <SettingItem
          label={t('settings.sync.account', 'Keep them in')}
          description={t('settings.sync.account_desc', 'One account holds the settings of the whole app.')}
        >
          <Select
            value={view.holder}
            onChange={(id) => { if (id) updateSetting('settingsSyncAccountId', id); }}
            options={accountOptions}
          />
        </SettingItem>
      )}
      {enabled && (
        <View style={styles.statusRow} testID="settings-sync-status">
          <View style={styles.statusText}>
            <Text style={styles.status}>{statusLine()}</Text>
            {tooLarge > 0 && (
              <Text style={styles.status}>
                {t(
                  'settings.sync.too_large',
                  '{count, plural, one {# long list stays} other {# long lists stay}} on this device: the account has no room for more.',
                  { count: tooLarge },
                )}
              </Text>
            )}
          </View>
          <Button
            variant="outline"
            size="sm"
            onPress={() => void syncNow()}
            loading={status === 'syncing'}
            disabled={!view.canSyncNow}
            // The offline mail card above has a "Sync now" of its own.
            accessibilityLabel={`${t('settings.sync.title', 'Settings sync')}: ${t('settings.offline.sync_now', 'Sync now')}`}
          >
            {t('settings.offline.sync_now', 'Sync now')}
          </Button>
        </View>
      )}
      {enabled && replacedCount > 0 && (
        <View style={styles.replaced} testID="settings-sync-replaced">
          <Text style={styles.replacedText}>
            {t(
              'settings.sync.replaced',
              '{count, plural, one {# setting on this device now follows} other {# settings on this device now follow}} your account.',
              { count: replacedCount },
            )}
          </Text>
          <View style={styles.replacedButtons}>
            <Button variant="outline" size="sm" onPress={keepReplaced}>
              {t('settings.sync.keep_mine', "Use this device's")}
            </Button>
            <Button variant="ghost" size="sm" onPress={dismissReplaced}>
              {t('common.close', 'Close')}
            </Button>
          </View>
        </View>
      )}
    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { gap: spacing.xxl },
    usageCard: {
      padding: 14,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.card,
      gap: 10,
    },
    usageHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap' },
    usageTitle: { ...typography.bodyMedium, color: c.text },
    usageSize: { ...typography.body, color: c.mutedForeground },
    progressTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: c.muted,
      overflow: 'hidden',
    },
    progressFill: { height: '100%', backgroundColor: c.text },
    usageFooter: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    usageSub: { ...typography.caption, color: c.mutedForeground },
    buttonPair: { flexDirection: 'row', gap: spacing.sm },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
    statusText: { flex: 1, gap: 2 },
    status: { ...typography.caption, color: c.mutedForeground },
    replaced: { gap: spacing.sm, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: c.border },
    replacedText: { ...typography.body, color: c.text },
    replacedButtons: { flexDirection: 'row', gap: spacing.sm },
  });
}
