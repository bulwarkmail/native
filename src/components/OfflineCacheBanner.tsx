// Live banner that mirrors the UpdateBanner's footprint, surfaced while the
// offline mail sync is running. Hidden once the sync settles to idle/done.

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { CloudDownload, X } from 'lucide-react-native';
import { useOfflineCacheStore } from '../stores/offline-cache-store';
import { formatBytes } from '../lib/offline-sync';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

export function OfflineCacheBanner(): React.ReactElement | null {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const sync = useOfflineCacheStore((s) => s.sync);
  const requestAbort = useOfflineCacheStore((s) => s.requestAbort);
  const resetSync = useOfflineCacheStore((s) => s.resetSync);
  const [hideTimer, setHideTimer] = React.useState<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss the "done" state after a few seconds so the bar isn't a
  // permanent fixture; the Settings screen still shows the cache stats.
  React.useEffect(() => {
    if (sync.phase === 'done' || sync.phase === 'cancelled') {
      const t = setTimeout(() => resetSync(), 4000);
      setHideTimer(t);
      return () => clearTimeout(t);
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

  let title = 'Offline sync';
  let subtitle = '';
  switch (sync.phase) {
    case 'scanning':
      title = 'Syncing offline mail';
      subtitle = 'Scanning recent messages…';
      break;
    case 'fetching':
      title = 'Syncing offline mail';
      subtitle = `${sync.completed}/${sync.total} • ${formatBytes(sync.bytes)}`;
      break;
    case 'done':
      title = 'Offline mail ready';
      subtitle = sync.fetched > 0
        ? `${sync.fetched} new message${sync.fetched === 1 ? '' : 's'} cached • ${formatBytes(sync.bytes)}`
        : 'Already up to date';
      break;
    case 'cancelled':
      title = 'Sync cancelled';
      subtitle = `${sync.completed}/${sync.total} processed`;
      break;
    case 'error':
      title = 'Offline sync failed';
      subtitle = sync.message ?? 'Unable to download';
      break;
    default:
      return null;
  }

  const showCancel = sync.phase === 'scanning' || sync.phase === 'fetching';
  const showDismiss = sync.phase === 'done' || sync.phase === 'cancelled' || sync.phase === 'error';
  const isError = sync.phase === 'error';

  return (
    <View style={[styles.banner, isError && styles.bannerError]}>
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
        <Pressable style={styles.cancelButton} onPress={requestAbort} hitSlop={6}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      )}
      {showDismiss && (
        <Pressable style={styles.dismiss} onPress={resetSync} hitSlop={8}>
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
