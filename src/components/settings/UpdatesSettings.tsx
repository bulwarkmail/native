import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Linking } from 'react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useUpdatesStore } from '../../stores/updates-store';
import { useLocaleStore, type TranslateFn } from '../../stores/locale-store';
import { stripMarkdown } from '../../api/updates';
import type { InstallProgress } from '../../lib/install-update';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatProgressLabel(p: InstallProgress, t: TranslateFn): string {
  const pct = p.progress != null ? `${Math.round(p.progress * 100)}%` : null;
  const written = p.bytesWritten ? formatBytes(p.bytesWritten) : null;
  const total = p.totalBytes ? formatBytes(p.totalBytes) : null;
  const sizes = written && total
    ? t('updates.progress_of', '{written} of {total}', { written, total })
    : written ?? '';
  return [pct, sizes].filter(Boolean).join(' · ') || t('updates.downloading', 'Downloading…');
}

function installButtonLabel(
  installing: boolean,
  progress: InstallProgress | null,
  t: TranslateFn,
): string {
  if (!installing) return t('updates.install', 'Install');
  if (progress?.phase === 'installing') return t('updates.installing', 'Installing…');
  if (progress?.phase === 'verifying') return t('updates.verifying', 'Verifying…');
  if (progress?.progress != null) {
    return t('updates.downloading_pct', 'Downloading {pct}%', { pct: Math.round(progress.progress * 100) });
  }
  return t('updates.downloading', 'Downloading…');
}

export function UpdatesSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const hydrated = useUpdatesStore((s) => s.hydrated);
  const hydrate = useUpdatesStore((s) => s.hydrate);
  const checking = useUpdatesStore((s) => s.checking);
  const installing = useUpdatesStore((s) => s.installing);
  const installProgress = useUpdatesStore((s) => s.installProgress);
  const error = useUpdatesStore((s) => s.error);
  const lastCheckedAt = useUpdatesStore((s) => s.lastCheckedAt);
  const rateLimitedUntil = useUpdatesStore((s) => s.rateLimitedUntil);
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
  const apkPending = updateAvailable && !apkAsset;
  const severity = cachedLatest?.severity ?? 'normal';
  const rateLimited = rateLimitedUntil > Date.now();

  useEffect(() => {
    if (!apkPending) return;
    const id = setInterval(() => {
      void checkNow({ force: true });
    }, 30_000);
    return () => clearInterval(id);
  }, [apkPending, checkNow]);

  const onInstall = () => {
    void installLatest();
  };

  const formatTime = (ts: number): string => (ts ? new Date(ts).toLocaleString() : t('updates.never', 'never'));

  const notes = cachedLatest?.body ? stripMarkdown(cachedLatest.body) : '';

  return (
    <View style={styles.container}>
      <SettingsSection
        title={t('updates.title', 'App updates')}
        description={t('updates.description', 'Check for new versions and install them.')}
      >
        <SettingItem label={t('updates.current_version', 'Current version')}>
          <Text style={styles.value}>v{currentVersion()}</Text>
        </SettingItem>

        <SettingItem
          label={t('updates.latest_version', 'Latest version')}
          description={cachedLatest?.publishedAt
            ? t('updates.published', 'Published {date}', { date: new Date(cachedLatest.publishedAt).toLocaleDateString() })
            : undefined}
        >
          <View style={styles.valueRow}>
            <Text style={styles.value}>{cachedLatest ? cachedLatest.tag : '-'}</Text>
            {updateAvailable && severity !== 'normal' && (
              <View style={styles.severityPill}>
                <Text style={styles.severityText}>
                  {severity === 'security'
                    ? t('updates.severity_security', 'Security')
                    : t('updates.severity_deprecated', 'Required')}
                </Text>
              </View>
            )}
          </View>
        </SettingItem>

        <SettingItem
          label={t('updates.last_checked', 'Last checked')}
          description={error
            ? t('updates.last_error', 'Last error: {message}', { message: error })
            : rateLimited
              ? t('updates.rate_limited', 'GitHub is rate-limiting update checks; trying again later.')
              : undefined}
        >
          <Text style={styles.value}>{formatTime(lastCheckedAt)}</Text>
        </SettingItem>

        <SettingItem
          label={t('updates.auto_check', 'Check automatically')}
          description={t('updates.auto_check_desc', 'Check for updates every few hours when the app starts.')}
        >
          <ToggleSwitch checked={autoCheck} onChange={setAutoCheck} />
        </SettingItem>

        <SettingItem
          label={
            apkPending
              ? t('updates.building', 'Update building')
              : updateAvailable
                ? t('updates.available', 'Update available')
                : t('updates.check', 'Check for updates')
          }
          description={
            apkPending
              ? t('updates.building_desc', 'v{version} was published, but the APK is still being built. This page will check again every 30 seconds.', { version: cachedLatest?.tag ?? '' })
              : updateAvailable
                ? t('updates.available_desc', "Tap install to download v{version} and open it with Android's package installer.", { version: cachedLatest?.tag ?? '' })
                : undefined
          }
        >
          {apkPending ? (
            <Button
              variant="outline"
              size="sm"
              onPress={() => void checkNow({ force: true })}
              disabled={checking}
            >
              {checking ? t('updates.checking', 'Checking…') : t('updates.check_again', 'Check again')}
            </Button>
          ) : updateAvailable ? (
            <Button
              variant="default"
              size="sm"
              onPress={onInstall}
              disabled={installing}
            >
              {installButtonLabel(installing, installProgress, t)}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onPress={() => void checkNow({ force: true })}
              disabled={checking}
            >
              {checking ? t('updates.checking', 'Checking…') : t('updates.check_now', 'Check now')}
            </Button>
          )}
        </SettingItem>

        {cachedLatest?.advisoryUrl && updateAvailable ? (
          <SettingItem
            label={t('updates.advisory', 'Security advisory')}
            description={t('updates.advisory_desc', 'Details about the issue this release fixes.')}
          >
            <Button variant="ghost" size="sm" onPress={() => void Linking.openURL(cachedLatest.advisoryUrl!)}>
              {t('updates.open', 'Open')}
            </Button>
          </SettingItem>
        ) : null}

        {cachedLatest?.htmlUrl ? (
          <SettingItem
            label={t('updates.release_page', 'Release page')}
            description={apkPending
              ? t('updates.release_page_pending_desc', 'Watch the build progress or download the APK manually.')
              : t('updates.release_page_desc', 'Full release notes and downloads on GitHub.')}
          >
            <Button
              variant="ghost"
              size="sm"
              onPress={() => void Linking.openURL(cachedLatest.htmlUrl)}
            >
              {t('updates.open_github', 'Open on GitHub')}
            </Button>
          </SettingItem>
        ) : null}

        {installing && installProgress ? (
          <View style={styles.progressBox}>
            <View style={styles.progressTrack} accessibilityRole="progressbar">
              <View
                style={[
                  styles.progressFill,
                  {
                    // The download is complete once it is verifying, so the
                    // bar stays full instead of restarting at 0.
                    width:
                      installProgress.phase === 'downloading'
                        ? `${Math.round((installProgress.progress ?? 0) * 100)}%`
                        : '100%',
                  },
                ]}
              />
            </View>
            <Text style={styles.progressLabel}>
              {installProgress.phase === 'installing'
                ? t('updates.opening_installer', 'Opening installer…')
                : installProgress.phase === 'verifying'
                  ? t('updates.verifying', 'Verifying…')
                  : formatProgressLabel(installProgress, t)}
            </Text>
          </View>
        ) : null}

        {notes ? (
          <View style={styles.notesBox}>
            <Text style={styles.notesTitle}>{t('updates.release_notes', 'Release notes')}</Text>
            <Text style={styles.notesBody} numberOfLines={30}>
              {notes}
            </Text>
          </View>
        ) : null}
      </SettingsSection>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { gap: spacing.xxxl },
  value: { ...typography.bodyMedium, color: c.text },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  severityPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: c.errorBg,
  },
  severityText: { ...typography.caption, color: c.error, fontWeight: '600' },
  notesBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.muted,
    gap: spacing.sm,
  },
  notesTitle: { ...typography.captionMedium, color: c.mutedForeground },
  notesBody: { ...typography.body, color: c.text, lineHeight: 20 },
  progressBox: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 6,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: c.muted,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: c.primary,
  },
  progressLabel: { ...typography.caption, color: c.mutedForeground },
});
}
