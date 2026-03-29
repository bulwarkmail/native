import React from 'react';
import { Pressable, Text, StyleSheet, ViewStyle, TextStyle, ActivityIndicator } from 'react-native';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';

type ButtonVariant = 'default' | 'ghost' | 'outline' | 'destructive';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  style?: ViewStyle;
}

export default function Button({
  variant = 'default',
  size = 'md',
  children,
  onPress,
  disabled = false,
  loading = false,
  icon,
  style,
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.base,
        sizeStyles[size],
        variantStyles[variant],
        pressed && !isDisabled && pressedStyles[variant],
        isDisabled && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={isDisabled}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'default' ? colors.primaryForeground : colors.primary}
        />
      ) : (
        <>
          {icon}
          {typeof children === 'string' ? (
            <Text style={[styles.text, textVariantStyles[variant], isDisabled && styles.textDisabled]}>
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

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,       // rounded-md (web)
    gap: spacing.sm,
  },
  text: {
    ...typography.bodyMedium,      // text-sm font-medium (web)
  },
  disabled: {
    opacity: 0.5,
  },
  textDisabled: {
    opacity: 0.5,
  },
});

// Matches web: h-9 (sm), h-10 (md), h-11 (lg), h-10 w-10 (icon)
const sizeStyles: Record<ButtonSize, ViewStyle> = {
  sm: {
    height: componentSizes.buttonSm,
    paddingHorizontal: spacing.md,   // px-3
  },
  md: {
    height: componentSizes.buttonMd,
    paddingHorizontal: spacing.lg,   // px-4
    paddingVertical: spacing.sm,     // py-2
  },
  lg: {
    height: componentSizes.buttonLg,
    paddingHorizontal: spacing.xxxl, // px-8
  },
  icon: {
    height: componentSizes.buttonMd,
    width: componentSizes.buttonMd,
    paddingHorizontal: 0,
  },
};

// Matches web button variant classes exactly
const variantStyles: Record<ButtonVariant, ViewStyle> = {
  default: {
    backgroundColor: colors.primary,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 1,
    elevation: 1,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  outline: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  destructive: {
    backgroundColor: colors.error,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 1,
    elevation: 1,
  },
};

const pressedStyles: Record<ButtonVariant, ViewStyle> = {
  default: {
    backgroundColor: colors.primaryDark,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  ghost: {
    backgroundColor: colors.accent,
  },
  outline: {
    backgroundColor: colors.accent,
  },
  destructive: {
    opacity: 0.9,
  },
};

const textVariantStyles: Record<ButtonVariant, TextStyle> = {
  default: {
    color: colors.primaryForeground,
  },
  ghost: {
    color: colors.text,
  },
  outline: {
    color: colors.text,
  },
  destructive: {
    color: colors.errorForeground,
  },
};
