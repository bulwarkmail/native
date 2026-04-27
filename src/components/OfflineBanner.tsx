import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CloudOff } from 'lucide-react-native';
import { useNetworkStore } from '../stores/network-store';
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
  if (online) return null;
  return (
    <View style={styles.bar}>
      <CloudOff size={14} color={c.primaryForeground} />
      <Text style={styles.text} numberOfLines={1}>
        You are offline{hint ? ` — ${hint}` : ''}
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
