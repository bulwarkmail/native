import React from 'react';
import { Pressable, type ViewStyle } from 'react-native';
import { Menu } from './icons';
import { spacing, radius, componentSizes } from '../theme/tokens';

// The header row of Mail, Calendar and Contacts. Its height, its padding and
// the button at its start are the same on all three, so the menu button
// stays in place when the user switches between them (#170).
export const screenHeaderRow: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  height: componentSizes.headerHeight,
  paddingHorizontal: spacing.sm,
};

// The button at the start of the row: the menu, or what takes its place
// (back, clear selection).
export const headerLeadingButton: ViewStyle = {
  width: componentSizes.buttonLg,
  height: componentSizes.buttonLg,
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: radius.full,
};

interface HeaderMenuButtonProps {
  onPress: () => void;
  accessibilityLabel: string;
  color: string;
  hitSlop?: number;
}

export function HeaderMenuButton({ onPress, accessibilityLabel, color, hitSlop }: HeaderMenuButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={hitSlop}
      style={headerLeadingButton}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Menu size={20} color={color} />
    </Pressable>
  );
}
