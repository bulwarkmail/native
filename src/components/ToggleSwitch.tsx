import React from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { radius, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

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
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
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

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  track: {
    width: componentSizes.toggleWidth,    // w-11 = 44
    height: componentSizes.toggleHeight,  // h-6  = 24
    borderRadius: radius.full,
    justifyContent: 'center',
  },
  trackOn: {
    backgroundColor: c.primary,
  },
  trackOff: {
    backgroundColor: c.muted,
  },
  thumb: {
    width: componentSizes.toggleThumb,    // h-4 w-4 = 16
    height: componentSizes.toggleThumb,
    borderRadius: radius.full,
    backgroundColor: c.background,
  },
  disabled: {
    opacity: 0.5,
  },
  });
}
