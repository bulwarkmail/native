import React from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { colors, radius, componentSizes } from '../theme/tokens';

interface ToggleSwitchProps {
  value: boolean;
  onValueChange: (val: boolean) => void;
  disabled?: boolean;
}

/**
 * Matches webmail ToggleSwitch:
 * - h-6 w-11 rounded-full
 * - checked: bg-primary, unchecked: bg-muted
 * - thumb: h-4 w-4 rounded-full bg-background
 * - translate-x-6 (checked) / translate-x-1 (unchecked)
 */
export default function ToggleSwitch({ value, onValueChange, disabled = false }: ToggleSwitchProps) {
  return (
    <Pressable
      style={[
        styles.track,
        value ? styles.trackOn : styles.trackOff,
        disabled && styles.disabled,
      ]}
      onPress={() => !disabled && onValueChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
    >
      <View
        style={[
          styles.thumb,
          { transform: [{ translateX: value ? 24 : 4 }] },
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: componentSizes.toggleWidth,    // w-11 = 44
    height: componentSizes.toggleHeight,  // h-6  = 24
    borderRadius: radius.full,
    justifyContent: 'center',
  },
  trackOn: {
    backgroundColor: colors.primary,
  },
  trackOff: {
    backgroundColor: colors.muted,
  },
  thumb: {
    width: componentSizes.toggleThumb,    // h-4 w-4 = 16
    height: componentSizes.toggleThumb,
    borderRadius: radius.full,
    backgroundColor: colors.background,
  },
  disabled: {
    opacity: 0.5,
  },
});
