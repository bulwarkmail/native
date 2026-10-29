import React from 'react';
import { View, Text, StyleSheet, Pressable, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Download, ShieldAlert, X } from './icons';
import { useUpdatesStore } from '../stores/updates-store';
import { useLocaleStore } from '../stores/locale-store';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

/**
 * Sideload-update banner. Normal releases can be dismissed per tag; security
 * and deprecated releases stay until installed (webmail parity, where the
 * version server's severity drives a red non-dismissable notice).
 */
export function UpdateBanner(): React.ReactElement | null {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const t = useLocaleStore((s) => s.t);
  const cachedLatest = useUpdatesStore((s) => s.cachedLatest);
  const dismissedTag = useUpdatesStore((s) => s.dismissedTag);
  const installing = useUpdatesStore((s) => s.installing);
  const installLatest = useUpdatesStore((s) => s.installLatest);
  const dismissCurrent = useUpdatesStore((s) => s.dismissCurrent);
  const hasUpdate = useUpdatesStore((s) => s.hasUpdate);
  const isMandatory = useUpdatesStore((s) => s.isMandatory);

  if (!hasUpdate()) return null;
  if (!cachedLatest?.apkAsset) return null;
  const mandatory = isMandatory();
  if (!mandatory && dismissedTag === cachedLatest.tag) return null;

  const severity = cachedLatest.severity;
  const title = severity === 'security'
    ? t('updates.banner.security_title', 'Security update available')
    : severity === 'deprecated'
      ? t('updates.banner.deprecated_title', 'This version is no longer supported')
      : t('updates.banner.title', 'Update available');
  const subtitle = severity === 'security'
    ? t('updates.banner.security_subtitle', 'v{version} fixes a security issue. Install it as soon as possible.', { version: cachedLatest.tag })
    : severity === 'deprecated'
      ? t('updates.banner.deprecated_subtitle', 'Install v{version} to keep using the app.', { version: cachedLatest.tag })
      : t('updates.banner.subtitle', 'v{version} is ready to install.', { version: cachedLatest.tag });

  return (
    <View
      style={[styles.banner, mandatory && styles.bannerMandatory, { paddingTop: spacing.md + insets.top }]}
      accessibilityRole="alert"
    >
      {mandatory
        ? <ShieldAlert size={16} color={c.primaryForeground} />
        : <Download size={16} color={c.primaryForeground} />}
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
        {cachedLatest.advisoryUrl ? (
          <Pressable
            onPress={() => void Linking.openURL(cachedLatest.advisoryUrl!)}
            accessibilityRole="link"
            hitSlop={4}
          >
            <Text style={styles.link}>{t('updates.banner.advisory', 'Read the advisory')}</Text>
          </Pressable>
        ) : null}
      </View>
      <Pressable
        style={styles.installButton}
        onPress={() => void installLatest()}
        disabled={installing}
        accessibilityRole="button"
        accessibilityLabel={t('updates.install', 'Install')}
      >
        <Text style={styles.installText}>{installing ? '…' : t('updates.install', 'Install')}</Text>
      </Pressable>
      {!mandatory && (
        <Pressable
          style={styles.dismiss}
          onPress={dismissCurrent}
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
    paddingVertical: spacing.md,
    backgroundColor: c.primary,
  },
  bannerMandatory: { backgroundColor: c.error },
  title: { ...typography.bodyMedium, color: c.primaryForeground },
  subtitle: { ...typography.caption, color: c.primaryForeground, opacity: 0.85 },
  link: { ...typography.captionMedium, color: c.primaryForeground, textDecorationLine: 'underline', marginTop: 2 },
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
