import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { STATUS_COLUMN_BUTTON } from '../lib/use-layout';
import { useColors } from '../theme/colors';

/** A toolbar button: drawn as an icon, named by its label (screen readers). */
export interface BarItem {
  key: string;
  icon: (size: number, color: string) => React.ReactNode;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
}

/**
 * A screen's toolbars in the status column of an iPhone Duo (`fitsStatusColumn`),
 * in Apple's order: Back, then the top toolbar's buttons, a gap, then the
 * bottom bar's ("Designing for iPhone Duo", Vertical controls). Symbols only,
 * as Apple asks for the column; each keeps its label for VoiceOver. Drawn over
 * the column (the window's right inset), at its foot, below the status bar.
 */
export default function StatusColumnBar({ back, top, bottom }: { back: BarItem; top: BarItem[]; bottom: BarItem[] }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const button = (item: BarItem, color: string) => (
    <Pressable
      key={item.key}
      onPress={item.disabled ? undefined : item.onPress}
      disabled={item.disabled}
      style={({ pressed }) => [styles.button, pressed && { backgroundColor: c.secondary }, item.disabled && styles.disabled]}
      hitSlop={2}
      accessibilityRole="button"
      accessibilityLabel={item.label}
      accessibilityState={{ disabled: !!item.disabled }}
    >
      {item.icon(21, color)}
    </Pressable>
  );
  return (
    <View accessibilityRole="toolbar" style={[styles.column, { width: insets.right, paddingBottom: insets.bottom + 8 }]}>
      {button(back, c.text)}
      {top.map((item) => button(item, c.textSecondary))}
      <View style={styles.gap} />
      {bottom.map((item) => button(item, c.textSecondary))}
    </View>
  );
}

const styles = StyleSheet.create({
  column: { position: 'absolute', top: 0, right: 0, bottom: 0, justifyContent: 'flex-end', alignItems: 'center' },
  button: { width: 48, height: STATUS_COLUMN_BUTTON, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  disabled: { opacity: 0.4 },
  gap: { height: 16 },
});
