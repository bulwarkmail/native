import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { colors, spacing, radius, typography } from '../theme/tokens';

interface BadgeProps {
  children: string;
  variant?: 'default' | 'primary' | 'destructive' | 'outline' | 'muted';
  style?: ViewStyle;
}

/**
 * Matches webmail badge patterns:
 * - rounded-full px-2 py-0.5 text-xs font-medium
 */
export default function Badge({ children, variant = 'default', style }: BadgeProps) {
  return (
    <View style={[styles.base, variantStyles[variant], style]}>
      <Text style={[styles.text, textVariantStyles[variant]]}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.full,
    paddingHorizontal: 8,        // px-2
    paddingVertical: 2,          // py-0.5
    alignSelf: 'flex-start',
  },
  text: {
    ...typography.caption,
    fontWeight: '500',
  },
});

const variantStyles: Record<string, ViewStyle> = {
  default: {
    backgroundColor: colors.surface,
  },
  primary: {
    backgroundColor: colors.primaryBg,
  },
  destructive: {
    backgroundColor: colors.errorBg,
  },
  outline: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  muted: {
    backgroundColor: colors.muted,
  },
};

const textVariantStyles: Record<string, { color: string }> = {
  default: { color: colors.text },
  primary: { color: colors.primary },
  destructive: { color: colors.error },
  outline: { color: colors.text },
  muted: { color: colors.mutedForeground },
};
