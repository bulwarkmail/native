// Port of webmail components/email/structured-mail/copy-value-chip.tsx at
// b0782af2d, on expo-clipboard like the app's VerificationCodeChip.
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Check, Copy } from '../../icons';
import { useLocaleStore } from '../../../stores/locale-store';
import { toast } from '../../../stores/toast-store';
import { useColors } from '../../../theme/colors';
import { radius, spacing, typography, type ThemePalette } from '../../../theme/tokens';
import { ltr } from './card-parts';

interface CopyValueChipProps {
  /** What a tap copies: a booking reference, order or tracking number. */
  value: string;
  /** The button's accessible name, naming what is copied ("Copy booking reference QX7K2M"). */
  copyLabel: string;
  /** The toast after copying ("Booking reference copied"). */
  copiedMessage: string;
  /** A visible label in front of the value ("Booking reference"). */
  label?: string;
  /** As tall as the buttons beside it, in an action row. */
  inActions?: boolean;
}

/** A number from a booking or parcel card; a tap copies it. Looks like the verification code chip. */
export function CopyValueChip({ value, copyLabel, copiedMessage, label, inActions }: CopyValueChipProps) {
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
    Clipboard.setStringAsync(value).then(
      () => {
        setCopied(true);
        toast.success(copiedMessage);
      },
      () => toast.error(t('email_viewer.structured_mail.copy_failed', 'Could not copy to the clipboard')),
    );
  };

  const Icon = copied ? Check : Copy;
  return (
    <Pressable
      onPress={copy}
      hitSlop={6}
      style={({ pressed }) => [styles.chip, inActions && styles.chipInActions, pressed && styles.chipPressed]}
      accessibilityRole="button"
      accessibilityLabel={copyLabel}
      testID="copy-value-chip"
    >
      <Icon size={12} color={copied ? c.success : c.textMuted} />
      {label ? <Text style={styles.label}>{label}</Text> : null}
      {/* Digit groups keep their order in a right-to-left UI. */}
      <Text style={styles.value} selectable>{ltr(value)}</Text>
    </Pressable>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 1,
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.background,
    },
    chipInActions: { minHeight: 36, paddingHorizontal: spacing.md, borderRadius: radius.md },
    chipPressed: { backgroundColor: c.surfaceHover },
    label: { ...typography.caption, color: c.textMuted },
    value: { ...typography.caption, color: c.text, fontWeight: '600', fontFamily: 'monospace', letterSpacing: 0.5, flexShrink: 1 },
  });
}
