import React from 'react';
import { Pressable, View, StyleSheet } from 'react-native';
import { radius, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

interface ToggleSwitchProps {
  value: boolean;
  onValueChange: (val: boolean) => void;
  disabled?: boolean;
  /** What the switch turns on or off, read out by screen readers. */
  accessibilityLabel?: string;
}

/**
 * The webmail switch in the standard theme: a 44 x 24 track, bg-primary when
 * on (knob in primary-foreground), bg-muted when off (knob in background).
 * The knob is 20 dp with 2 dp of track around it.
 */
export default function ToggleSwitch({ value, onValueChange, disabled = false, accessibilityLabel }: ToggleSwitchProps) {
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
      // The track is 44 x 24; the touch area reaches 48 dp high.
      hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
    >
      <View
        style={[
          styles.thumb,
          value ? styles.thumbOn : styles.thumbOff,
          { transform: [{ translateX: value ? 22 : 2 }] },
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
    width: componentSizes.toggleThumb,
    height: componentSizes.toggleThumb,
    borderRadius: radius.full,
  },
  thumbOn: {
    backgroundColor: c.primaryForeground,
  },
  thumbOff: {
    backgroundColor: c.background,
  },
  disabled: {
    opacity: 0.5,
  },
  });
}
