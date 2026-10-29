import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { radius, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

interface BadgeProps {
  /** Sentence case ("Not on this server"); badges are never upper case. */
  children: string;
  variant?: 'default' | 'primary' | 'destructive' | 'outline' | 'muted';
  style?: ViewStyle;
}

/**
 * A small status pill. The default is the webmail's outline badge: hairline
 * border, muted 12px text. The tinted variants keep the same size.
 */
export default function Badge({ children, variant = 'default', style }: BadgeProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={[styles.base, styles[`bg_${variant}` as const], style]}>
      <Text style={[styles.text, styles[`text_${variant}` as const]]} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    base: {
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: 'transparent',
      paddingHorizontal: 8,
      paddingVertical: 1,
      alignSelf: 'flex-start',
    },
    text: { fontSize: 12, lineHeight: 16 },

    bg_default:     { borderColor: c.border },
    bg_outline:     { borderColor: c.border },
    bg_primary:     { backgroundColor: c.accent },
    bg_destructive: { backgroundColor: c.errorBg },
    bg_muted:       { backgroundColor: c.muted },

    text_default:     { color: c.mutedForeground },
    text_outline:     { color: c.mutedForeground },
    text_primary:     { color: c.accentForeground },
    text_destructive: { color: c.error },
    text_muted:       { color: c.mutedForeground },
  });
}
