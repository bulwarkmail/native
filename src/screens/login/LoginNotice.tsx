import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { AlertTriangle, Lock } from '../../components/icons';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { announce } from '../../lib/announce';

interface LoginNoticeProps {
  title: string;
  detail?: string;
  tone?: 'error' | 'info';
  /**
   * Read out when it appears, in either tone (a status, not a static hint):
   * the code prompt is info now (webmail #1422) but still news.
   */
  live?: boolean;
}

/** Inline banner for a sign-in failure, or a reassurance about where a
 *  password ends up. Errors lead with what went wrong, then what to do. */
export default function LoginNotice({ title, detail, tone = 'error', live }: LoginNoticeProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const isError = tone === 'error';
  const Icon = isError ? AlertTriangle : Lock;
  const isLive = live ?? isError;
  // iOS reads no live regions.
  React.useEffect(() => {
    if (isLive) announce([title, detail].filter(Boolean).join('. '), { assertive: isError });
  }, [isLive, isError, title, detail]);

  return (
    <View
      style={[styles.banner, isError ? styles.bannerError : styles.bannerInfo]}
      accessibilityLiveRegion={isLive ? 'polite' : 'none'}
    >
      <Icon size={16} color={isError ? c.error : c.textMuted} style={styles.icon} />
      <View style={styles.text}>
        <Text style={[styles.title, isError ? styles.titleError : styles.titleInfo]}>{title}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    banner: {
      flexDirection: 'row',
      gap: spacing.sm,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    bannerError: { backgroundColor: c.errorBg, borderWidth: 1, borderColor: c.errorBorder },
    bannerInfo: { backgroundColor: 'transparent', paddingHorizontal: 0 },
    icon: { marginTop: 1 },
    text: { flex: 1, gap: 2 },
    title: { ...typography.captionMedium },
    titleError: { color: c.error },
    titleInfo: { color: c.textSecondary },
    detail: { ...typography.caption, color: c.textSecondary, lineHeight: 17 },
  });
}
