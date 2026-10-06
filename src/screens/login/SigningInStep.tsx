import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors, useResolvedTheme } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { getAccountInitials } from '../../lib/avatar-utils';
import { toUnicodeEmail } from '../../lib/idn';

// The white mark disappears on the light palette, so pick per theme.
const LOGO_LIGHT = require('../../../assets/logos/Bulwark Logo Dark.png');
const LOGO_DARK = require('../../../assets/logos/Bulwark Logo White.png');

export type SigningInPhase = 'browser' | 'connecting' | 'pairing';

interface SigningInStepProps {
  phase: SigningInPhase;
  serverUrl: string | null;
  email: string | null;
}

function hostOf(url: string | null): string {
  if (!url) return 'your server';
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
}

function initialsOf(email: string): string {
  return getAccountInitials('', email);
}

/**
 * Covers the wait while a sign-in is in flight. Naming the server and the
 * current stage makes a slow first connection legible instead of a bare
 * spinner that could mean anything.
 */
export default function SigningInStep({ phase, serverUrl, email }: SigningInStepProps) {
  const c = useColors();
  const theme = useResolvedTheme();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const host = serverUrl ? hostOf(serverUrl) : t('login.mobile.your_server', 'your server');

  const copy: Record<SigningInPhase, { title: string; detail: string }> = {
    browser: {
      title: t('login.mobile.opening', 'Opening {host}', { host }),
      detail: t('login.mobile.opening_detail', 'Finish signing in on the page that just opened. We’ll take it from there.'),
    },
    connecting: { title: t('login.mobile.connecting', 'Connecting to {host}', { host }), detail: t('login.mobile.connecting_detail', 'Setting up your mailbox…') },
    pairing: { title: t('login.mobile.pairing', 'Redeeming your sign-in code'), detail: t('login.mobile.pairing_detail', 'Pairing this device with {host}…', { host }) },
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {email ? (
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initialsOf(email)}</Text>
          </View>
        ) : (
          <Image
            source={theme === 'light' ? LOGO_LIGHT : LOGO_DARK}
            style={styles.logo}
            resizeMode="contain"
          />
        )}

        {email ? <Text style={styles.email}>{toUnicodeEmail(email)}</Text> : null}
        <Text style={styles.title}>{copy[phase].title}</Text>
        <Text style={styles.detail}>{copy[phase].detail}</Text>

        <ActivityIndicator size="small" color={c.primary} style={styles.spinner} />
      </View>
    </SafeAreaView>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    content: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      gap: spacing.xs,
    },
    avatar: {
      width: componentSizes.avatarLg,
      height: componentSizes.avatarLg,
      borderRadius: radius.full,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.md,
    },
    avatarText: { ...typography.h3, color: c.primaryForeground },
    logo: { width: componentSizes.avatarLg, height: componentSizes.avatarLg, marginBottom: spacing.md },
    email: { ...typography.caption, color: c.textMuted },
    title: { ...typography.h2, color: c.text, textAlign: 'center' },
    detail: { ...typography.body, color: c.textSecondary, textAlign: 'center' },
    spinner: { marginTop: spacing.xl },
  });
}
