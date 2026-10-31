import React from 'react';
import { Pressable, Text, StyleSheet, ViewStyle, ActivityIndicator } from 'react-native';
import { spacing, radius, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

/**
 * The webmail's standard-theme buttons (components/ui/button.tsx):
 * - default: bg-primary text-primary-foreground
 * - secondary: bg-muted text-foreground
 * - outline: border, transparent
 * - ghost: no border or fill until pressed
 * - destructive: red fill, white text
 * - destructiveOutline: red border and text, for a reset in a settings row
 * All 36 dp tall (lg 44 for a page's main action), radius 6, 14px medium.
 */
type ButtonVariant = 'default' | 'secondary' | 'ghost' | 'outline' | 'destructive' | 'destructiveOutline';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  style?: ViewStyle;
  /** Needed for an icon-only button; a text button reads its text. */
  accessibilityLabel?: string;
}

// Extra touch area so every size reaches a 48 dp target.
const HIT_SLOP: Record<ButtonSize, number> = { sm: 6, md: 6, lg: 2, icon: 4 };

export default function Button({
  variant = 'default',
  size = 'md',
  children,
  onPress,
  disabled = false,
  loading = false,
  icon,
  style,
  accessibilityLabel,
}: ButtonProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const isDisabled = disabled || loading;
  const spinnerColor = variant === 'default'
    ? c.primaryForeground
    : variant === 'destructive' ? '#ffffff' : c.text;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.base,
        styles[`size_${size}` as const],
        styles[`bg_${variant}` as const],
        pressed && !isDisabled && styles[`pressed_${variant}` as const],
        isDisabled && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={isDisabled}
      hitSlop={HIT_SLOP[size]}
      accessibilityRole="button"
      // A text button names itself by its text: React Native only replaces a
      // content description with a non-empty one, so without it TalkBack kept
      // reading "busy" after the spinner went away.
      accessibilityLabel={accessibilityLabel ?? (typeof children === 'string' ? children : undefined)}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
    >
      {loading ? (
        <ActivityIndicator size="small" color={spinnerColor} />
      ) : (
        <>
          {icon}
          {typeof children === 'string' ? (
            <Text style={[styles.text, styles[`text_${variant}` as const]]} numberOfLines={1}>
              {children}
            </Text>
          ) : (
            children
          )}
        </>
      )}
    </Pressable>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    base: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.sm, gap: spacing.sm,
    },
    text: { fontSize: 14, fontWeight: '500', lineHeight: 20 },
    disabled: { opacity: 0.5 },

    // minHeight, so a larger system font grows the button instead of clipping.
    size_sm:   { minHeight: componentSizes.buttonSm, paddingHorizontal: spacing.md },
    size_md:   { minHeight: componentSizes.buttonSm, paddingHorizontal: 14 },
    size_lg:   { minHeight: componentSizes.buttonLg, paddingHorizontal: spacing.xxl },
    size_icon: { height: componentSizes.buttonMd, width: componentSizes.buttonMd, paddingHorizontal: 0 },

    bg_default:            { backgroundColor: c.primary },
    bg_secondary:          { backgroundColor: c.muted },
    bg_ghost:              { backgroundColor: 'transparent' },
    bg_outline:            { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.border },
    bg_destructive:        { backgroundColor: c.error },
    bg_destructiveOutline: { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.error },

    pressed_default:            { opacity: 0.9 },
    pressed_secondary:          { opacity: 0.8 },
    pressed_ghost:              { backgroundColor: c.muted },
    pressed_outline:            { backgroundColor: c.muted },
    pressed_destructive:        { opacity: 0.9 },
    pressed_destructiveOutline: { backgroundColor: c.errorBg },

    text_default:            { color: c.primaryForeground },
    text_secondary:          { color: c.text },
    text_ghost:              { color: c.text },
    text_outline:            { color: c.text },
    text_destructive:        { color: '#ffffff' },
    text_destructiveOutline: { color: c.error },
  });
}
