import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

interface BadgeProps {
  children: string;
  variant?: 'default' | 'primary' | 'destructive' | 'outline' | 'muted';
  style?: ViewStyle;
}

export default function Badge({ children, variant = 'default', style }: BadgeProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={[styles.base, styles[`bg_${variant}` as const], style]}>
      <Text style={[styles.text, styles[`text_${variant}` as const]]}>
        {children}
      </Text>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    base: {
      borderRadius: radius.full,
      paddingHorizontal: 8,
      paddingVertical: 2,
      alignSelf: 'flex-start',
    },
    text: { ...typography.caption, fontWeight: '500' },

    bg_default:     { backgroundColor: c.surface },
    bg_primary:     { backgroundColor: c.primaryBg },
    bg_destructive: { backgroundColor: c.errorBg },
    bg_outline:     { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.border },
    bg_muted:       { backgroundColor: c.muted },

    text_default:     { color: c.text },
    text_primary:     { color: c.primary },
    text_destructive: { color: c.error },
    text_outline:     { color: c.text },
    text_muted:       { color: c.mutedForeground },
  });
}

