import React from 'react';
import { TextInput as RNTextInput, View, Text, StyleSheet, ViewStyle, TextInputProps } from 'react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { inputAccessibility } from './input-a11y';

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  containerStyle?: ViewStyle;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  /** React 19 passes `ref` as a prop; it reaches the TextInput (focus chaining). */
  ref?: React.Ref<RNTextInput>;
}

/**
 * Matches webmail input.tsx in the standard theme:
 * - h-10 rounded-md border border-input, transparent background
 * - px-3 text-sm text-foreground, placeholder in muted-foreground
 * - focus: border-ring
 * - disabled: opacity-50
 * - label above in text-sm font-medium text-foreground
 */
export default function Input({
  label,
  error,
  containerStyle,
  leftIcon,
  rightIcon,
  style,
  ref,
  ...props
}: InputProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [focused, setFocused] = React.useState(false);

  return (
    <View style={containerStyle}>
      {label && <Text style={styles.label}>{label}</Text>}
      <View style={[
        styles.inputWrapper,
        focused && styles.inputFocused,
        error && styles.inputError,
        props.editable === false && styles.inputDisabled,
      ]}>
        {leftIcon && <View style={styles.iconLeft}>{leftIcon}</View>}
        <RNTextInput
          ref={ref}
          {...props}
          {...inputAccessibility({ label, error, placeholder: props.placeholder, accessibilityLabel: props.accessibilityLabel, accessibilityHint: props.accessibilityHint })}
          style={[styles.input, style]}
          placeholderTextColor={c.mutedForeground}
          onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
          onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
        />
        {rightIcon && <View style={styles.iconRight}>{rightIcon}</View>}
      </View>
      {error && <Text style={styles.errorText}>{error}</Text>}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  label: {
    ...typography.bodyMedium,
    color: c.text,
    marginBottom: 6,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: componentSizes.inputHeight, // h-10 = 40px; grows with a larger system font
    borderWidth: 1,
    borderColor: c.border,            // border-input
    borderRadius: radius.sm,               // rounded-md = 6px
    backgroundColor: 'transparent',
    paddingHorizontal: spacing.md,         // px-3 = 12px
  },
  // Colour only, so focusing doesn't shift the text by a pixel.
  inputFocused: {
    borderColor: c.borderFocus,
  },
  inputError: {
    borderColor: c.error,
  },
  inputDisabled: {
    opacity: 0.5,
  },
  input: {
    flex: 1,
    ...typography.body,                   // text-sm = 14px
    color: c.text,                   // text-foreground
    paddingVertical: 0,
  },
  iconLeft: {
    marginRight: spacing.sm,
  },
  iconRight: {
    marginLeft: spacing.sm,
  },
  errorText: {
    ...typography.caption,
    color: c.error,
    marginTop: spacing.xs,
  },
  });
}
