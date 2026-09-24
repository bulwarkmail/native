// Live banner that mirrors the UpdateBanner's footprint, surfaced while the
// offline mail sync is running. Hidden once the sync settles to idle/done.

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CloudDownload, X } from 'lucide-react-native';
import { useOfflineCacheStore } from '../stores/offline-cache-store';
import { useUpdatesStore } from '../stores/updates-store';
import { formatBytes } from '../lib/offline-sync';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useLocaleStore } from '../stores/locale-store';

export function OfflineCacheBanner(): React.ReactElement | null {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const t = useLocaleStore((s) => s.t);
  const sync = useOfflineCacheStore((s) => s.sync);
  const requestAbort = useOfflineCacheStore((s) => s.requestAbort);
  const resetSync = useOfflineCacheStore((s) => s.resetSync);
  // When UpdateBanner is stacked above us it already absorbs the status-bar
  // inset, so we only add it when we're the topmost banner.
  const cachedLatest = useUpdatesStore((s) => s.cachedLatest);
  const dismissedTag = useUpdatesStore((s) => s.dismissedTag);
  const hasUpdate = useUpdatesStore((s) => s.hasUpdate);
  const updateBannerVisible =
    hasUpdate() && cachedLatest?.apkAsset != null && dismissedTag !== cachedLatest.tag;
  const topInset = updateBannerVisible ? 0 : insets.top;
  const [hideTimer, setHideTimer] = React.useState<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss the "done" state after a few seconds so the bar isn't a
  // permanent fixture; the Settings screen still shows the cache stats.
  React.useEffect(() => {
    if (sync.phase === 'done' || sync.phase === 'cancelled') {
      const timer = setTimeout(() => resetSync(), 4000);
      setHideTimer(timer);
      return () => clearTimeout(timer);
    }
    if (hideTimer) clearTimeout(hideTimer);
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.phase, resetSync]);

  if (sync.phase === 'idle') return null;

  const pct =
    sync.total > 0
      ? Math.min(100, Math.round((sync.completed / sync.total) * 100))
      : sync.phase === 'done' ? 100 : 0;

  let title = t('offline.sync.title', 'Offline sync');
  let subtitle = '';
  switch (sync.phase) {
    case 'scanning':
      title = t('offline.sync.syncing', 'Syncing offline mail');
      subtitle = t('settings.offline.scanning', 'Scanning recent mail…');
      break;
    case 'fetching':
      title = t('offline.sync.syncing', 'Syncing offline mail');
      subtitle = `${sync.completed}/${sync.total} • ${formatBytes(sync.bytes)}`;
      break;
    case 'done':
      title = t('offline.sync.ready', 'Offline mail ready');
      subtitle = sync.fetched > 0
        ? t(
          'offline.sync.cached_count',
          '{count, plural, one {# new message cached} other {# new messages cached}} • {size}',
          { count: sync.fetched, size: formatBytes(sync.bytes) },
        )
        : t('offline.sync.up_to_date', 'Already up to date');
      break;
    case 'cancelled':
      title = t('offline.sync.cancelled', 'Sync cancelled');
      subtitle = t('offline.sync.processed', '{completed}/{total} processed', { completed: sync.completed, total: sync.total });
      break;
    case 'error':
      title = t('offline.sync.failed', 'Offline sync failed');
      subtitle = sync.message ?? t('offline.sync.unable_to_download', 'Unable to download');
      break;
    default:
      return null;
  }

  const showCancel = sync.phase === 'scanning' || sync.phase === 'fetching';
  const showDismiss = sync.phase === 'done' || sync.phase === 'cancelled' || sync.phase === 'error';
  const isError = sync.phase === 'error';

  return (
    <View style={[styles.banner, isError && styles.bannerError, { paddingTop: spacing.sm + topInset }]}>
      <CloudDownload size={16} color={c.primaryForeground} />
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{title}</Text>
        {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        {(sync.phase === 'fetching' || sync.phase === 'scanning') && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${pct}%` }]} />
          </View>
        )}
      </View>
      {showCancel && (
        <Pressable style={styles.cancelButton} onPress={requestAbort} hitSlop={6} accessibilityRole="button">
          <Text style={styles.cancelText}>{t('common.cancel', 'Cancel')}</Text>
        </Pressable>
      )}
      {showDismiss && (
        <Pressable
          style={styles.dismiss}
          onPress={resetSync}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.dismiss', 'Dismiss')}
        >
          <X size={14} color={c.primaryForeground} />
        </Pressable>
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: c.primary,
    },
    bannerError: { backgroundColor: c.error },
    title: { ...typography.bodyMedium, color: c.primaryForeground },
    subtitle: { ...typography.caption, color: c.primaryForeground, opacity: 0.85, marginTop: 2 },
    progressTrack: {
      marginTop: 6,
      height: 3,
      borderRadius: radius.full,
      backgroundColor: 'rgba(255,255,255,0.25)',
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      backgroundColor: c.primaryForeground,
    },
    cancelButton: {
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.sm,
      backgroundColor: 'rgba(255,255,255,0.2)',
    },
    cancelText: { ...typography.captionMedium, color: c.primaryForeground },
    dismiss: { padding: 4 },
  });
}
