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
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { usePolicyFeature } from '../../stores/policy-store';
import { useOfflineCacheStore } from '../../stores/offline-cache-store';
import { useOutboxStore } from '../../stores/outbox-store';
import { runOfflineSync, formatBytes } from '../../lib/offline-sync';

interface StorageSettingsProps {
  /** Opens Troubleshooting (refresh cached data, debug logging). */
  onOpenTroubleshooting?: () => void;
}

/** Settings → Storage & backup: offline mail, settings export/import, reset. */
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
        description={t('settings.offline.description_short', 'Keep recent messages on this phone so they open without a connection.')}
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

      <SettingsSection
        title={t('settings.backup.title', 'Settings backup')}
        description={t('settings.backup.description', 'Move your settings to another phone or the webmail.')}
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
        message={t('settings.reset_confirm', 'Are you sure you want to reset all settings to defaults?')}
        confirmText={t('settings.advanced.reset_settings.button', 'Reset to Defaults')}
        onCancel={() => setConfirmReset(false)}
        onConfirm={handleReset}
      />
    </View>
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
  });
}
