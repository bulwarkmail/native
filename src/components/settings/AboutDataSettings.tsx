import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Linking, Alert, ActivityIndicator } from 'react-native';
import Constants from 'expo-constants';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { CloudDownload, ExternalLink } from 'lucide-react-native';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import Button from '../Button';
import Dialog from '../Dialog';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { ALL_DEBUG_CATEGORIES, useSettingsStore, type DebugCategory } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { useOfflineCacheStore } from '../../stores/offline-cache-store';
import { useOutboxStore } from '../../stores/outbox-store';
import { useUpdatesStore } from '../../stores/updates-store';
import { runOfflineSync, formatBytes } from '../../lib/offline-sync';
import { clearCachedData } from '../../lib/clear-cached-data';
import { supportsSideloadUpdates } from '../../lib/platform-capabilities';

const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
const GIT_COMMIT = (Constants.expoConfig?.extra as { commit?: string } | undefined)?.commit ?? 'dev';
const APP_STORE_URL = 'https://github.com/bulwarkmail/native/releases';

export function AboutDataSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const senderFavicons = useSettingsStore((s) => s.senderFavicons);
  const setSenderFaviconsStore = useSettingsStore((s) => s.setSenderFavicons);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const resetToDefaults = useSettingsStore((s) => s.resetToDefaults);
  const exportSettings = useSettingsStore((s) => s.exportSettings);
  const importSettings = useSettingsStore((s) => s.importSettings);
  const debugMode = useSettingsStore((s) => s.debugMode);
  const debugCategories = useSettingsStore((s) => s.debugCategories);

  const [confirmReset, setConfirmReset] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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

  const hasUpdate = useUpdatesStore((s) => s.hasUpdate);
  const latestRelease = useUpdatesStore((s) => s.cachedLatest);
  const updateAvailable = hasUpdate();
  const updateSeverity = latestRelease?.severity ?? 'normal';

  useEffect(() => {
    if (!hydrated) void hydrate();
    if (!cacheHydrated) void cacheHydrate();
  }, [hydrated, hydrate, cacheHydrated, cacheHydrate]);

  const dayOptions = [1, 3, 7, 14, 30, 90].map((d) => ({
    value: String(d),
    label: d === 1
      ? t('settings.offline.window_24h', 'Last 24 hours')
      : t('settings.offline.window_days', 'Last {count} days', { count: d }),
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

  const handleRefreshCache = async () => {
    setRefreshing(true);
    try {
      await clearCachedData();
    } catch (err) {
      Alert.alert(
        t('settings.advanced.refresh_cache.label', 'Refresh cached data'),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.aboutBox}>
        <View style={styles.aboutRow}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>B</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.aboutTitle}>{t('settings.advanced.about.mobile_title', 'Bulwark Mobile')}</Text>
            <Text style={styles.aboutVersion}>
              v{APP_VERSION}{' '}
              <Text style={styles.aboutCommit}>({GIT_COMMIT})</Text>
            </Text>
            {updateAvailable && latestRelease && (
              <Pressable
                onPress={() => void Linking.openURL(latestRelease.htmlUrl || APP_STORE_URL)}
                accessibilityRole="link"
                style={[styles.updatePill, updateSeverity !== 'normal' && styles.updatePillSecurity]}
              >
                <Text style={[styles.updatePillText, updateSeverity !== 'normal' && styles.updatePillTextSecurity]}>
                  {updateSeverity === 'security'
                    ? t('settings.advanced.about.security_update', 'Security update: {version}', { version: latestRelease.tag })
                    : updateSeverity === 'deprecated'
                      ? t('settings.advanced.about.deprecated_update', 'Update required: {version}', { version: latestRelease.tag })
                      : t('settings.advanced.about.update_available', 'Update: {version}', { version: latestRelease.tag })}
                  {supportsSideloadUpdates
                    ? ''
                    : ` · ${t('settings.advanced.about.update_store_hint', 'available in TestFlight / App Store')}`}
                </Text>
              </Pressable>
            )}
          </View>
          <Pressable
            style={styles.ghLink}
            accessibilityRole="link"
            onPress={() => Linking.openURL('https://github.com/bulwarkmail/native')}
          >
            <Text style={styles.ghText}>GitHub</Text>
            <ExternalLink size={12} color={c.mutedForeground} />
          </Pressable>
        </View>
      </View>

      <SettingsSection
        title={t('settings.offline.title', 'Offline mail')}
        description={t(
          'settings.offline.description',
          'Download recent messages so they open instantly and remain readable without a connection. Bodies only — attachments are still fetched on demand.',
        )}
      >
        <SettingItem
          label={t('settings.offline.enabled', 'Cache recent mail')}
          description={t('settings.offline.enabled_desc', 'When on, the app keeps message bodies for the selected window on this device.')}
        >
          <ToggleSwitch
            checked={offlineEnabled}
            onChange={(v) => updateSetting('offlineCacheEnabled', v)}
          />
        </SettingItem>
        <SettingItem
          label={t('settings.offline.window', 'Window')}
          description={t('settings.offline.window_desc', 'How far back to cache, measured by message receipt date.')}
        >
          <Select
            value={String(offlineDays)}
            onChange={(v) => updateSetting('offlineCacheDays', Number(v))}
            options={dayOptions}
          />
        </SettingItem>
        <SettingItem
          label={t('settings.offline.max_size', 'Maximum size')}
          description={t('settings.offline.max_size_desc', 'Oldest messages are removed when the cache grows past this.')}
        >
          <Select
            value={String(offlineMaxMB)}
            onChange={(v) => updateSetting('offlineCacheMaxMB', Number(v))}
            options={maxMbOptions}
          />
        </SettingItem>

        <View style={styles.cacheStatsBox}>
          <View style={styles.cacheStatsHeader}>
            <CloudDownload size={16} color={c.textSecondary} />
            <Text style={styles.cacheStatsTitle}>
              {cacheCount === 0
                ? t('settings.offline.nothing_cached', 'Nothing cached yet')
                : `${t('settings.offline.cached_count', '{count, plural, one {# message} other {# messages}}', { count: cacheCount })} • ${formatBytes(cacheBytes)}`}
            </Text>
          </View>
          <Text style={styles.cacheStatsSub}>
            {sync.phase === 'fetching'
              ? t('settings.offline.downloading', 'Downloading {completed}/{total}…', { completed: sync.completed, total: sync.total })
              : sync.phase === 'scanning'
                ? t('settings.offline.scanning', 'Scanning recent mail…')
                : sync.phase === 'error'
                  ? t('settings.offline.last_sync_failed', 'Last sync failed: {message}', { message: sync.message ?? t('identities.validation_errors.unknown_error', 'Unknown error') })
                  : t('settings.offline.last_sync', 'Last sync {when}', { when: formatRelativeTime(sync.finishedAt) })}
          </Text>
          {queuedChanges > 0 && (
            <Text style={styles.cacheStatsSub}>
              {t('settings.offline.queued_changes', '{count, plural, one {# change} other {# changes}} waiting to sync', { count: queuedChanges })}
            </Text>
          )}
          {syncBusy && sync.total > 0 && (
            <View style={styles.progressTrack} accessibilityRole="progressbar">
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.min(100, Math.round((sync.completed / sync.total) * 100))}%` },
                ]}
              />
            </View>
          )}
          <View style={styles.cacheActions}>
            <Button
              variant="outline"
              size="sm"
              onPress={handleSyncNow}
              disabled={!offlineEnabled || syncBusy}
              icon={syncBusy ? <ActivityIndicator size="small" color={c.text} /> : undefined}
            >
              {syncBusy ? t('settings.offline.syncing', 'Syncing…') : t('settings.offline.sync_now', 'Sync now')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onPress={handleClearCache}
              disabled={cacheCount === 0 || syncBusy}
            >
              {t('settings.offline.clear_cache', 'Clear cache')}
            </Button>
          </View>
        </View>
      </SettingsSection>

      <SettingsSection
        title={t('settings.advanced.title', 'Advanced')}
        description={t('settings.advanced.description', 'Advanced options and developer settings')}
      >
        <SettingItem
          label={t('settings.advanced.debug_mode.label', 'Debug Mode')}
          description={t('settings.advanced.debug_mode.description', 'Enable detailed logging for troubleshooting')}
        >
          <ToggleSwitch checked={debugMode} onChange={(v) => updateSetting('debugMode', v)} />
        </SettingItem>

        {debugMode && (
          <View style={styles.debugCategoriesBox}>
            <Text style={styles.debugCategoriesHint}>
              {t(
                'settings.advanced.debug_categories.description',
                "Select which categories to log. Disable categories you don't need to reduce console noise.",
              )}
            </Text>
            {ALL_DEBUG_CATEGORIES.map((cat: DebugCategory) => (
              <SettingItem
                key={cat}
                label={t(`settings.advanced.debug_categories.${cat}`, cat)}
                description={t(`settings.advanced.debug_categories.${cat}_description`, '')}
              >
                <ToggleSwitch
                  checked={debugCategories[cat] !== false}
                  onChange={(v) => updateSetting('debugCategories', { ...debugCategories, [cat]: v })}
                />
              </SettingItem>
            ))}
          </View>
        )}

        <SettingItem
          label={t('settings.advanced.sender_favicons.label', 'Sender Favicons')}
          description={t('settings.advanced.sender_favicons.description', 'Show website icons as profile pictures for business senders')}
        >
          <ToggleSwitch checked={senderFavicons} onChange={setSenderFaviconsStore} />
        </SettingItem>

        <SettingItem
          label={t('settings.advanced.refresh_cache.label', 'Refresh cached data')}
          description={t(
            'settings.advanced.refresh_cache.description',
            'Reload contacts, calendars, and folders from the server. Keeps your accounts and sessions — fixes a stale or wrong view without signing out.',
          )}
        >
          <Button variant="outline" size="sm" onPress={() => void handleRefreshCache()} loading={refreshing}>
            {t('settings.advanced.refresh_cache.button', 'Refresh')}
          </Button>
        </SettingItem>

        <SettingItem
          label={t('settings.advanced.export_settings.label', 'Export Settings')}
          description={t('settings.advanced.export_settings.description', 'Download your settings as JSON')}
        >
          <Button variant="outline" size="sm" onPress={() => void handleExport()}>
            {t('settings.advanced.export_settings.button', 'Export')}
          </Button>
        </SettingItem>

        <SettingItem
          label={t('settings.advanced.import_settings.label', 'Import Settings')}
          description={t('settings.advanced.import_settings.description', 'Upload settings from JSON file')}
        >
          <Button variant="outline" size="sm" onPress={() => void handleImport()}>
            {t('settings.advanced.import_settings.button', 'Import')}
          </Button>
        </SettingItem>

        <SettingItem
          label={t('settings.advanced.reset_settings.label', 'Reset Settings')}
          description={t('settings.advanced.reset_settings.description', 'Restore all settings to default values')}
        >
          <Button variant="outline" size="sm" onPress={() => setConfirmReset(true)}>
            {t('settings.advanced.reset_settings.button', 'Reset to Defaults')}
          </Button>
        </SettingItem>
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
  container: { gap: spacing.xxxl },
  aboutBox: {
    padding: spacing.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.card,
  },
  aboutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  logo: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { fontSize: 24, fontWeight: '700', color: c.primaryForeground },
  aboutTitle: { ...typography.bodyMedium, color: c.text },
  aboutVersion: { ...typography.caption, color: c.mutedForeground, marginTop: 2 },
  aboutCommit: { color: c.mutedForeground, opacity: 0.6 },
  updatePill: {
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: c.primaryBg,
  },
  updatePillSecurity: { backgroundColor: c.errorBg },
  updatePillText: { ...typography.caption, color: c.primary },
  updatePillTextSecurity: { color: c.error },
  ghLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ghText: { ...typography.caption, color: c.mutedForeground },
  debugCategoriesBox: {
    marginStart: spacing.lg,
    paddingStart: spacing.lg,
    borderStartWidth: 2,
    borderStartColor: c.muted,
    gap: 4,
  },
  debugCategoriesHint: {
    ...typography.caption,
    color: c.mutedForeground,
    marginBottom: spacing.sm,
  },
  cacheStatsBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.muted,
    gap: spacing.sm,
  },
  cacheStatsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  cacheStatsTitle: { ...typography.bodyMedium, color: c.text, flex: 1 },
  cacheStatsSub: { ...typography.caption, color: c.mutedForeground },
  progressTrack: {
    height: 4,
    borderRadius: radius.full,
    backgroundColor: c.border,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: c.primary },
  cacheActions: { flexDirection: 'row', gap: spacing.sm, marginTop: 4 },
});
}
