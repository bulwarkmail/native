import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Linking, Alert } from 'react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { colors, spacing, radius, typography } from '../../theme/tokens';
import { useUpdatesStore } from '../../stores/updates-store';

function formatTime(ts: number): string {
  if (!ts) return 'never';
  const date = new Date(ts);
  return date.toLocaleString();
}

export function UpdatesSettings() {
  const hydrated = useUpdatesStore((s) => s.hydrated);
  const hydrate = useUpdatesStore((s) => s.hydrate);
  const checking = useUpdatesStore((s) => s.checking);
  const installing = useUpdatesStore((s) => s.installing);
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
          <Text style={styles.value}>{cachedLatest ? cachedLatest.tag : '—'}</Text>
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
              {installing ? 'Downloading…' : apkAsset ? 'Install' : 'Open release'}
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
});
