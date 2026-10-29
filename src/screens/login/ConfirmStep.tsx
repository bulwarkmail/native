import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Globe } from '../../components/icons';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { Button } from '../../components';
import LoginNotice from './LoginNotice';
import { useLocaleStore } from '../../stores/locale-store';

interface ConfirmStepProps {
  serverUrl: string;
  /** False when the user supplied the address — we didn't find anything. */
  discovered: boolean;
  onContinue: () => void;
  onChangeServer: () => void;
  onUsePassword: () => void;
  notice?: { title: string; detail?: string } | null;
}

function hostOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
}

/**
 * Names the server before the browser opens. A sign-in that jumps to a browser
 * with no warning reads as a bug; saying which server, and why the password
 * isn't asked for here, turns the detour into the point.
 */
export default function ConfirmStep({
  serverUrl,
  discovered,
  onContinue,
  onChangeServer,
  onUsePassword,
  notice,
}: ConfirmStepProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  return (
    <View style={styles.root}>
      <View style={styles.heading}>
        <Text style={styles.title}>
          {discovered ? t('login.mobile.confirm_found', 'Found your mail server') : t('login.mobile.confirm_check', 'Check this looks right')}
        </Text>
        <Text style={styles.subtitle}>{t('login.mobile.confirm_subtitle', "Next you'll sign in on your provider's own page.")}</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.cardIcon}>
          <Globe size={20} color={c.primary} />
        </View>
        <View style={styles.cardText}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {hostOf(serverUrl)}
          </Text>
          {!serverUrl.startsWith('https://') ? (
            <View style={styles.cardMetaRow}>
              <View style={styles.dot} />
              <Text style={styles.cardMeta}>{t('login.mobile.unencrypted', 'Unencrypted connection')}</Text>
            </View>
          ) : null}
        </View>
      </View>

      <LoginNotice
        tone="info"
        title={t('login.mobile.provider_title', 'Your password stays with your provider')}
        detail={t('login.mobile.provider_detail', "You'll type it on their page. Bulwark only stores a sign-in token, which you can revoke at any time.")}
      />

      {notice ? <LoginNotice title={notice.title} detail={notice.detail} /> : null}

      <Button variant="default" size="md" onPress={onContinue}>
        {t('login.mobile.continue', 'Continue')}
      </Button>

      <View style={styles.links}>
        <Pressable onPress={onUsePassword} hitSlop={8}>
          <Text style={styles.link}>{t('login.mobile.use_password', 'Sign in with a password instead')}</Text>
        </Pressable>
        <Pressable onPress={onChangeServer} hitSlop={8}>
          <Text style={styles.linkMuted}>{t('login.mobile.different_server', 'Use a different server')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    root: { gap: spacing.lg },
    heading: { gap: spacing.sm },
    title: { ...typography.h1, color: c.text },
    subtitle: { ...typography.body, color: c.textSecondary },

    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.card,
      borderRadius: radius.lg,
      padding: spacing.md,
    },
    cardIcon: { width: 24, alignItems: 'center' },
    cardText: { flex: 1, gap: 2 },
    cardTitle: { ...typography.bodyMedium, color: c.text },
    cardMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    dot: { width: 5, height: 5, borderRadius: radius.full, backgroundColor: c.warning },
    cardMeta: { ...typography.caption, color: c.textSecondary },

    links: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
    link: { ...typography.body, color: c.textLink },
    linkMuted: { ...typography.body, color: c.textMuted },
  });
}
