import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CloudOff } from 'lucide-react-native';
import { useNetworkStore } from '../stores/network-store';
import { useOutboxStore } from '../stores/outbox-store';
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
  // Pending offline mutations that will replay once we're back online.
  const queued = useOutboxStore((s) => s.entries.length);
  if (online) return null;
  const queuedHint = queued > 0
    ? `${queued} change${queued === 1 ? '' : 's'} will sync when you reconnect`
    : null;
  const suffix = [hint, queuedHint].filter(Boolean).join(' · ');
  return (
    <View style={styles.bar}>
      <CloudOff size={14} color={c.primaryForeground} />
      <Text style={styles.text} numberOfLines={1}>
        You are offline{suffix ? ` — ${suffix}` : ''}
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
      backgroundColor: '#a16207',
    },
    text: {
      ...typography.caption,
      color: c.primaryForeground,
      flex: 1,
    },
  });
}
