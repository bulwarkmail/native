import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CloudOff } from './icons';
import { useNetworkStore } from '../stores/network-store';
import { useOutboxStore } from '../stores/outbox-store';
import { useLocaleStore } from '../stores/locale-store';
import { spacing, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

interface OfflineBannerProps {
  /** Optional extra notice (e.g. "Showing cached mail"). */
  hint?: string;
}

export function OfflineBanner({ hint }: OfflineBannerProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const online = useNetworkStore((s) => s.online);
  const t = useLocaleStore((s) => s.t);
  // Pending offline mutations that will replay once we're back online.
  const queued = useOutboxStore((s) => s.entries.length);
  if (online) return null;
  const queuedHint = queued > 0
    ? t(
      'offline.queued_changes',
      '{count, plural, one {# change} other {# changes}} will sync when you reconnect',
      { count: queued },
    )
    : null;
  const suffix = [hint, queuedHint].filter(Boolean).join(' · ');
  const label = t('offline.banner', 'You are offline');
  return (
    <View style={styles.bar} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <CloudOff size={14} color={c.warningForeground} />
      <Text style={styles.text} numberOfLines={1}>
        {suffix ? `${label} — ${suffix}` : label}
      </Text>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      backgroundColor: c.warning,
    },
    text: {
      ...typography.caption,
      color: c.warningForeground,
      flex: 1,
    },
  });
}
