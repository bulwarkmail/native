import React from 'react';
import { TextInput as RNTextInput, View, Text, StyleSheet, ViewStyle, TextInputProps } from 'react-native';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  containerStyle?: ViewStyle;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

/**
 * Matches webmail input.tsx:
 * - h-10 w-full rounded-md border border-input bg-background
 * - px-3 py-2 text-sm text-foreground
 * - placeholder:text-muted-foreground
 * - hover:border-muted-foreground
 * - focus:ring-2 ring-ring border-ring
 * - disabled:opacity-50
 */
export default function Input({
  label,
  error,
  containerStyle,
  leftIcon,
  rightIcon,
  style,
  ...props
}: InputProps) {
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
          {...props}
          style={[styles.input, style]}
          placeholderTextColor={colors.textMuted}
          onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
          onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
        />
        {rightIcon && <View style={styles.iconRight}>{rightIcon}</View>}
      </View>
      {error && <Text style={styles.errorText}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    ...typography.bodyMedium,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    height: componentSizes.inputHeight,    // h-10 = 40px
    borderWidth: 1,
    borderColor: colors.border,            // border-input
    borderRadius: radius.sm,               // rounded-md = 6px
    backgroundColor: colors.background,    // bg-background
    paddingHorizontal: spacing.md,         // px-3 = 12px
  },
  inputFocused: {
    borderColor: colors.borderFocus,       // border-ring (blue-500)
    borderWidth: 2,
  },
  inputError: {
    borderColor: colors.error,
  },
  inputDisabled: {
    opacity: 0.5,
  },
  input: {
    flex: 1,
    ...typography.body,                   // text-sm = 14px
    color: colors.text,                   // text-foreground
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
    color: colors.error,
    marginTop: spacing.xs,
  },
});
