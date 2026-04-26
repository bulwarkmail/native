import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Download, X } from 'lucide-react-native';
import { useUpdatesStore } from '../stores/updates-store';
import { colors, spacing, radius, typography } from '../theme/tokens';

export function UpdateBanner(): React.ReactElement | null {
  const cachedLatest = useUpdatesStore((s) => s.cachedLatest);
  const dismissedTag = useUpdatesStore((s) => s.dismissedTag);
  const installing = useUpdatesStore((s) => s.installing);
  const installLatest = useUpdatesStore((s) => s.installLatest);
  const dismissCurrent = useUpdatesStore((s) => s.dismissCurrent);
  const hasUpdate = useUpdatesStore((s) => s.hasUpdate);

  if (!hasUpdate()) return null;
  if (cachedLatest && dismissedTag === cachedLatest.tag) return null;
  if (!cachedLatest?.apkAsset) return null;

  return (
    <View style={styles.banner}>
      <Download size={16} color={colors.primaryForeground} />
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>Update available</Text>
        <Text style={styles.subtitle}>
          v{cachedLatest.tag} is ready to install.
        </Text>
      </View>
      <Pressable
        style={styles.installButton}
        onPress={() => void installLatest()}
        disabled={installing}
      >
        <Text style={styles.installText}>{installing ? '…' : 'Install'}</Text>
      </Pressable>
      <Pressable style={styles.dismiss} onPress={dismissCurrent} hitSlop={8}>
        <X size={14} color={colors.primaryForeground} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.primary,
  },
  title: { ...typography.bodyMedium, color: colors.primaryForeground },
  subtitle: { ...typography.caption, color: colors.primaryForeground, opacity: 0.85 },
  installButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  installText: { ...typography.captionMedium, color: colors.primaryForeground },
  dismiss: { padding: 4 },
});
