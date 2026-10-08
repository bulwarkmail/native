import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ShieldAlert } from 'lucide-react-native';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import type { SenderVerification } from '../../lib/email-headers';
import { senderCheckText } from '../../lib/sender-check';

interface Props {
  verification: SenderVerification;
}

/**
 * Warning above the message when the server's checks don't back the From
 * address's domain (webmail email-viewer's sender-check row). The verdict
 * comes from the Authentication-Results headers only, never the body.
 */
export function SenderCheckBanner({ verification }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const text = senderCheckText(verification, t);
  if (!text) return null;
  const tone = text.tone === 'danger' ? c.error : c.warning;

  return (
    <View style={styles.banner} accessibilityRole="alert">
      <View style={[styles.icon, { backgroundColor: text.tone === 'danger' ? c.errorBg : c.warningBg }]}>
        <ShieldAlert size={18} color={tone} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.label, { color: tone }]}>{text.label}</Text>
        <Text style={styles.message}>{text.message}</Text>
        <Text style={styles.caution}>{text.caution}</Text>
      </View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: c.surfaceHover,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    icon: {
      width: 32,
      height: 32,
      borderRadius: radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    body: { flex: 1, minWidth: 0, gap: 2 },
    label: { ...typography.small, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
    message: { ...typography.caption, color: c.text, fontWeight: '500' },
    caution: { ...typography.caption, color: c.textSecondary },
  });
}
