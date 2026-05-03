import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Linking, Alert, ActivityIndicator } from 'react-native';
import Constants from 'expo-constants';
import { CloudDownload, ExternalLink } from 'lucide-react-native';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import { useOfflineCacheStore } from '../../stores/offline-cache-store';
import { runOfflineSync, formatBytes } from '../../lib/offline-sync';

const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';
const GIT_COMMIT = (Constants.expoConfig?.extra as { commit?: string } | undefined)?.commit ?? 'dev';

const DAY_OPTIONS = [
  { value: '1',  label: 'Last 24 hours' },
  { value: '3',  label: 'Last 3 days' },
  { value: '7',  label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

function formatRelativeTime(ms: number | undefined): string {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))} h ago`;
  return `${Math.round(diff / (24 * 60 * 60_000))} d ago`;
}

const DEBUG_CATEGORIES = [
  { id: 'jmap',       label: 'JMAP',       description: 'JMAP request and response logs.' },
  { id: 'auth',       label: 'Auth',       description: 'Authentication and session events.' },
  { id: 'sync',       label: 'Sync',       description: 'Background sync operations.' },
  { id: 'render',     label: 'Render',     description: 'React render counts and timings.' },
];

export function AboutDataSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const senderFavicons = useSettingsStore((s) => s.senderFavicons);
  const setSenderFaviconsStore = useSettingsStore((s) => s.setSenderFavicons);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const resetExternalContentPolicy = useSettingsStore((s) => s.setExternalContentPolicy);
  const trustedSenders = useSettingsStore((s) => s.trustedSenders);
  const removeTrustedSender = useSettingsStore((s) => s.removeTrustedSender);

  const [debugMode, setDebugMode] = useState(false);
  const [debugCategories, setDebugCategories] = useState<Record<string, boolean>>(
    Object.fromEntries(DEBUG_CATEGORIES.map((c) => [c.id, true]))
  );
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [confirmReset, setConfirmReset] = useState(false);

  const offlineEnabled = useSettingsStore((s) => s.offlineCacheEnabled);
  const offlineDays = useSettingsStore((s) => s.offlineCacheDays);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
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

  const handleSyncNow = () => {
    void runOfflineSync({ days: offlineDays });
  };

  const handleClearCache = () => {
    Alert.alert(
      'Clear offline mail',
      `Remove ${cacheCount} cached message${cacheCount === 1 ? '' : 's'} (${formatBytes(cacheBytes)})?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear', style: 'destructive', onPress: () => { void clearAllCache(); } },
      ],
    );
  };

  const handleReset = () => {
    resetExternalContentPolicy('ask');
    setSenderFaviconsStore(true);
    for (const email of trustedSenders) removeTrustedSender(email);
    setConfirmReset(false);
    Alert.alert('Settings reset', 'Saved settings have been restored to defaults.');
  };

  return (
    <View style={styles.container}>
      <View style={styles.aboutBox}>
        <View style={styles.aboutRow}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>B</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.aboutTitle}>About</Text>
            <Text style={styles.aboutVersion}>
              v{APP_VERSION}{' '}
              <Text style={styles.aboutCommit}>({GIT_COMMIT})</Text>
            </Text>
          </View>
          <Pressable
            style={styles.ghLink}
            onPress={() => Linking.openURL('https://github.com/bulwarkmail/webmail')}
          >
            <Text style={styles.ghText}>GitHub</Text>
            <ExternalLink size={12} color={c.mutedForeground} />
          </Pressable>
        </View>
      </View>

      <SettingsSection
        title="Offline mail"
        description="Download recent messages so they open instantly and remain readable without a connection. Bodies only — attachments are still fetched on demand."
      >
        <SettingItem
          label="Cache recent mail"
          description="When on, the app keeps message bodies for the selected window on this device."
        >
          <ToggleSwitch
            checked={offlineEnabled}
            onChange={(v) => updateSetting('offlineCacheEnabled', v)}
          />
        </SettingItem>
        <SettingItem
          label="Window"
          description="How far back to cache, measured by message receipt date."
        >
          <Select
            value={String(offlineDays)}
            onChange={(v) => updateSetting('offlineCacheDays', Number(v))}
            options={DAY_OPTIONS}
          />
        </SettingItem>

        <View style={styles.cacheStatsBox}>
          <View style={styles.cacheStatsHeader}>
            <CloudDownload size={16} color={c.textSecondary} />
            <Text style={styles.cacheStatsTitle}>
              {cacheCount === 0
                ? 'Nothing cached yet'
                : `${cacheCount} message${cacheCount === 1 ? '' : 's'} • ${formatBytes(cacheBytes)}`}
            </Text>
          </View>
          <Text style={styles.cacheStatsSub}>
            {sync.phase === 'fetching'
              ? `Downloading ${sync.completed}/${sync.total}…`
              : sync.phase === 'scanning'
                ? 'Scanning recent mail…'
                : sync.phase === 'error'
                  ? `Last sync failed: ${sync.message ?? 'unknown error'}`
                  : `Last sync ${formatRelativeTime(sync.finishedAt)}`}
          </Text>
          {syncBusy && sync.total > 0 && (
            <View style={styles.progressTrack}>
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
              {syncBusy ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onPress={handleClearCache}
              disabled={cacheCount === 0 || syncBusy}
            >
              Clear cache
            </Button>
          </View>
        </View>
      </SettingsSection>

      <SettingsSection title="Advanced" description="Low-level options and troubleshooting.">
        <SettingItem label="Debug mode" description="Enable verbose logging for support and development.">
          <ToggleSwitch checked={debugMode} onChange={setDebugMode} />
        </SettingItem>

        {debugMode && (
          <View style={styles.debugCategoriesBox}>
            <Text style={styles.debugCategoriesHint}>
              Which categories to include in debug output.
            </Text>
            {DEBUG_CATEGORIES.map((cat) => (
              <SettingItem key={cat.id} label={cat.label} description={cat.description}>
                <ToggleSwitch
                  checked={debugCategories[cat.id] !== false}
                  onChange={(v) => setDebugCategories({ ...debugCategories, [cat.id]: v })}
                />
              </SettingItem>
            ))}
          </View>
        )}

        <SettingItem label="Settings sync" description="Sync settings across your signed-in devices.">
          <ToggleSwitch checked={syncEnabled} onChange={setSyncEnabled} />
        </SettingItem>

        <SettingItem
          label="Sender favicons"
          description="Fetch website favicons for sender avatars (experimental)."
        >
          <ToggleSwitch checked={senderFavicons} onChange={setSenderFaviconsStore} />
        </SettingItem>

        <SettingItem label="Reset settings" description="Restore saved preferences (external content, trusted senders, favicons) to defaults.">
          <Button
            variant={confirmReset ? 'destructive' : 'outline'}
            size="sm"
            onPress={() => {
              if (confirmReset) {
                handleReset();
              } else {
                setConfirmReset(true);
                setTimeout(() => setConfirmReset(false), 5000);
              }
            }}
          >
            {confirmReset ? 'Confirm reset' : 'Reset'}
          </Button>
        </SettingItem>
      </SettingsSection>
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
  ghLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ghText: { ...typography.caption, color: c.mutedForeground },
  debugCategoriesBox: {
    marginLeft: spacing.lg,
    paddingLeft: spacing.lg,
    borderLeftWidth: 2,
    borderLeftColor: c.muted,
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
