import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Linking, Alert } from 'react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { colors, spacing, radius, typography } from '../../theme/tokens';
import { useUpdatesStore } from '../../stores/updates-store';
import type { InstallProgress } from '../../lib/install-update';

function formatTime(ts: number): string {
  if (!ts) return 'never';
  const date = new Date(ts);
  return date.toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatProgressLabel(p: InstallProgress): string {
  const pct = p.progress != null ? `${Math.round(p.progress * 100)}%` : null;
  const written = p.bytesWritten ? formatBytes(p.bytesWritten) : null;
  const total = p.totalBytes ? formatBytes(p.totalBytes) : null;
  const sizes = written && total ? `${written} of ${total}` : written ?? '';
  return [pct, sizes].filter(Boolean).join(' · ') || 'Downloading…';
}

function installButtonLabel(
  installing: boolean,
  progress: InstallProgress | null,
  apkAsset: unknown,
): string {
  if (!installing) return apkAsset ? 'Install' : 'Open release';
  if (progress?.phase === 'installing') return 'Installing…';
  if (progress?.progress != null) return `Downloading ${Math.round(progress.progress * 100)}%`;
  return 'Downloading…';
}

export function UpdatesSettings() {
  const hydrated = useUpdatesStore((s) => s.hydrated);
  const hydrate = useUpdatesStore((s) => s.hydrate);
  const checking = useUpdatesStore((s) => s.checking);
  const installing = useUpdatesStore((s) => s.installing);
  const installProgress = useUpdatesStore((s) => s.installProgress);
  const error = useUpdatesStore((s) => s.error);
  const lastCheckedAt = useUpdatesStore((s) => s.lastCheckedAt);
  const cachedLatest = useUpdatesStore((s) => s.cachedLatest);
  const autoCheck = useUpdatesStore((s) => s.autoCheck);
  const setAutoCheck = useUpdatesStore((s) => s.setAutoCheck);
  const checkNow = useUpdatesStore((s) => s.checkNow);
  const installLatest = useUpdatesStore((s) => s.installLatest);
  const currentVersion = useUpdatesStore((s) => s.currentVersion);
  const hasUpdate = useUpdatesStore((s) => s.hasUpdate);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const updateAvailable = hasUpdate();
  const apkAsset = cachedLatest?.apkAsset ?? null;

  const onInstall = () => {
    if (!apkAsset) {
      if (cachedLatest?.htmlUrl) {
        void Linking.openURL(cachedLatest.htmlUrl);
      }
      return;
    }
    void installLatest();
  };

  return (
    <View style={styles.container}>
      <SettingsSection title="App updates" description="Check for new versions and install them.">
        <SettingItem label="Current version">
          <Text style={styles.value}>v{currentVersion()}</Text>
        </SettingItem>

        <SettingItem
          label="Latest version"
          description={cachedLatest?.publishedAt ? `Published ${new Date(cachedLatest.publishedAt).toLocaleDateString()}` : undefined}
        >
          <Text style={styles.value}>{cachedLatest ? cachedLatest.tag : '-'}</Text>
        </SettingItem>

        <SettingItem
          label="Last checked"
          description={error ? `Last error: ${error}` : undefined}
        >
          <Text style={styles.value}>{formatTime(lastCheckedAt)}</Text>
        </SettingItem>

        <SettingItem label="Check automatically" description="Check for updates every few hours when the app starts.">
          <ToggleSwitch checked={autoCheck} onChange={setAutoCheck} />
        </SettingItem>

        <SettingItem
          label={updateAvailable ? 'Update available' : 'Check for updates'}
          description={updateAvailable
            ? `Tap install to download v${cachedLatest?.tag} and open it with Android's package installer.`
            : undefined}
        >
          {updateAvailable ? (
            <Button
              variant="default"
              size="sm"
              onPress={onInstall}
              disabled={installing}
            >
              {installButtonLabel(installing, installProgress, apkAsset)}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onPress={() => void checkNow({ force: true })}
              disabled={checking}
            >
              {checking ? 'Checking…' : 'Check now'}
            </Button>
          )}
        </SettingItem>

        {installing && installProgress ? (
          <View style={styles.progressBox}>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width:
                      installProgress.phase === 'installing'
                        ? '100%'
                        : `${Math.round((installProgress.progress ?? 0) * 100)}%`,
                  },
                ]}
              />
            </View>
            <Text style={styles.progressLabel}>
              {installProgress.phase === 'installing'
                ? 'Opening installer…'
                : formatProgressLabel(installProgress)}
            </Text>
          </View>
        ) : null}

        {cachedLatest?.body ? (
          <View style={styles.notesBox}>
            <Text style={styles.notesTitle}>Release notes</Text>
            <Text style={styles.notesBody} numberOfLines={20}>
              {cachedLatest.body.trim()}
            </Text>
          </View>
        ) : null}
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xxxl },
  value: { ...typography.bodyMedium, color: colors.text },
  notesBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.muted,
    gap: spacing.sm,
  },
  notesTitle: { ...typography.caption, color: colors.mutedForeground, textTransform: 'uppercase' },
  notesBody: { ...typography.body, color: colors.text, lineHeight: 20 },
  progressBox: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 6,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.muted,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  progressLabel: { ...typography.caption, color: colors.mutedForeground },
});
