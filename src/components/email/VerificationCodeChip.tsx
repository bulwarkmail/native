import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Copy } from 'lucide-react-native';
import { CHROME_MAX_FONT_SCALE, radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { toast } from '../../stores/toast-store';

type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

/** Copies a code to the clipboard and says so, as the chip does. */
export function copyVerificationCode(code: string, t: Translate): void {
  Clipboard.setStringAsync(code).then(
    () => toast.success(t('email_viewer.verification_code.copied', 'Code copied')),
    () => toast.error(t('email_viewer.verification_code.copy_failed', 'Could not copy the code')),
  );
}

interface Props {
  code: string;
  /** Selection mode in the list: taps belong to the row. */
  disabled?: boolean;
}

/**
 * One-tap copy for the code of a sign-in or confirmation mail. A Pressable of
 * its own, so a tap in the list copies without opening the row.
 */
export const VerificationCodeChip = React.memo(function VerificationCodeChip({ code, disabled }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  const copy = React.useCallback(() => copyVerificationCode(code, t), [code, t]);

  return (
    <View style={styles.row}>
      <Pressable
        disabled={disabled}
        onPress={copy}
        style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
        accessibilityRole="button"
        accessibilityLabel={t('email_viewer.verification_code.copy', 'Copy code {code}', { code })}
      >
        <Copy size={12} color={c.textSecondary} />
        <Text style={styles.code} numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_FONT_SCALE}>{code}</Text>
      </Pressable>
    </View>
  );
});

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: { flexDirection: 'row', marginTop: spacing.xs },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.surface,
    },
    chipPressed: { backgroundColor: c.surfaceHover },
    code: { ...typography.caption, color: c.text, fontVariant: ['tabular-nums'], letterSpacing: 1 },
  });
}
