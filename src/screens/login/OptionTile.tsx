import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ChevronRight } from '../../components/icons';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

interface OptionTileProps {
  title: string;
  description?: string;
  /** Receives the colour the tile's icon renders in. */
  renderIcon: (color: string, size: number) => React.ReactNode;
  onPress: () => void;
  emphasis?: 'primary' | 'default';
  disabled?: boolean;
}

/**
 * A full-width choice on the sign-in screen: icon, what it does, and what it
 * costs you. Used instead of a stack of buttons so each route can say enough
 * to be picked without trial and error. Emphasis follows the settings-row
 * convention — a tinted icon chip, not a solid card.
 */
export default function OptionTile({
  title,
  description,
  renderIcon,
  onPress,
  emphasis = 'default',
  disabled = false,
}: OptionTileProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const isPrimary = emphasis === 'primary';
  const iconColor = isPrimary ? c.primary : c.textSecondary;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={description ? `${title}. ${description}` : title}
      style={({ pressed }) => [
        styles.tile,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <View style={styles.icon}>{renderIcon(iconColor, 20)}</View>
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
      <ChevronRight size={18} color={c.textMuted} />
    </Pressable>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    tile: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.card,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    pressed: { backgroundColor: c.surfaceHover },
    disabled: { opacity: 0.5 },
    icon: { width: 24, alignItems: 'center' },
    text: { flex: 1, gap: 2 },
    title: { ...typography.bodyMedium, color: c.text },
    description: { ...typography.caption, color: c.mutedForeground },
  });
}
