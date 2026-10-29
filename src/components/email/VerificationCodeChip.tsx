import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Check, Key } from '../icons';
import type { Email } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import { toast } from '../../stores/toast-store';
import { listVerificationCode } from '../../lib/verification-code';

/** The code a list row offers: found in the subject and preview of a fresh mail. */
export function useListVerificationCode(email: Pick<Email, 'subject' | 'preview' | 'receivedAt'>): string | null {
  const enabled = useSettingsStore((s) => s.showVerificationCodes);
  const { subject, preview, receivedAt } = email;
  return React.useMemo(
    () => (enabled ? listVerificationCode({ subject, preview, receivedAt }) : null),
    [enabled, subject, preview, receivedAt],
  );
}

interface Props {
  code: string;
  /** A list row in selection mode: the tap selects the row instead. */
  disabled?: boolean;
  /** Spacing for a list row (below the preview). */
  inList?: boolean;
}

/** The one-time code of a sign-in mail (lib/verification-code.ts); a tap copies it. */
export function VerificationCodeChip({ code, disabled, inList }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    Clipboard.setStringAsync(code).then(
      () => {
        setCopied(true);
        toast.success(t('email_viewer.verification_code.copied', 'Code copied'));
      },
      () => toast.error(t('email_viewer.verification_code.copy_failed', 'Could not copy the code')),
    );
  };

  const Icon = copied ? Check : Key;
  const label = t('email_viewer.verification_code.copy', 'Copy code {code}', { code });
  return (
    <View style={[styles.row, inList && styles.rowInList]}>
      <Pressable
        onPress={copy}
        disabled={disabled}
        hitSlop={6}
        style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID="verification-code-chip"
      >
        <Icon size={12} color={copied ? c.success : c.warning} />
        <Text style={styles.code} numberOfLines={1}>{code}</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: { flexDirection: 'row' },
    rowInList: { marginTop: spacing.xs },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.surface,
    },
    chipPressed: { backgroundColor: c.surfaceHover },
    code: { ...typography.caption, color: c.text, fontWeight: '600', fontFamily: 'monospace', letterSpacing: 0.5 },
  });
}
