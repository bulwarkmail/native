import React from 'react';
import { View, Text, Pressable, StyleSheet, ViewStyle } from 'react-native';
import { colors, spacing, radius, typography } from '../theme/tokens';

interface RadioOption {
  label: string;
  value: string;
}

interface RadioGroupProps {
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  style?: ViewStyle;
}

/**
 * Matches webmail RadioGroup (button variant):
 * - container: flex gap-1.5
 * - button: px-3 py-1.5 text-xs rounded-md
 * - selected: bg-primary text-primary-foreground font-medium
 * - unselected: bg-muted text-foreground
 */
export default function RadioGroup({ options, value, onChange, style }: RadioGroupProps) {
  return (
    <View style={[styles.container, style]}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            style={[styles.option, selected ? styles.optionSelected : styles.optionUnselected]}
            onPress={() => onChange(opt.value)}
          >
            <Text style={[styles.optionText, selected ? styles.textSelected : styles.textUnselected]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 6,                          // gap-1.5
  },
  option: {
    paddingHorizontal: spacing.md,   // px-3
    paddingVertical: 6,              // py-1.5
    borderRadius: radius.sm,         // rounded-md
  },
  optionSelected: {
    backgroundColor: colors.primary,
  },
  optionUnselected: {
    backgroundColor: colors.muted,
  },
  optionText: {
    ...typography.caption,           // text-xs
  },
  textSelected: {
    color: colors.primaryForeground,
    fontWeight: '500',
  },
  textUnselected: {
    color: colors.text,
  },
});
