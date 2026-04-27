import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CloudOff } from 'lucide-react-native';
import { useNetworkStore } from '../stores/network-store';
import { colors, spacing, typography } from '../theme/tokens';

interface OfflineBannerProps {
  /** Optional extra notice (e.g. "Showing cached mail"). */
  hint?: string;
}

export function OfflineBanner({ hint }: OfflineBannerProps) {
  const online = useNetworkStore((s) => s.online);
  if (online) return null;
  return (
    <View style={styles.bar}>
      <CloudOff size={14} color={colors.primaryForeground} />
      <Text style={styles.text} numberOfLines={1}>
        You are offline{hint ? ` — ${hint}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
    color: colors.primaryForeground,
    flex: 1,
  },
});
