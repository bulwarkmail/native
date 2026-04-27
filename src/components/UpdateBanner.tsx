import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Download, X } from 'lucide-react-native';
import { useUpdatesStore } from '../stores/updates-store';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

export function UpdateBanner(): React.ReactElement | null {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
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
      <Download size={16} color={c.primaryForeground} />
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
        <X size={14} color={c.primaryForeground} />
      </Pressable>
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
    paddingVertical: spacing.md,
    backgroundColor: c.primary,
  },
  title: { ...typography.bodyMedium, color: c.primaryForeground },
  subtitle: { ...typography.caption, color: c.primaryForeground, opacity: 0.85 },
  installButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  installText: { ...typography.captionMedium, color: c.primaryForeground },
  dismiss: { padding: 4 },
  });
}
