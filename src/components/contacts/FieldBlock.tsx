import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Plus, X } from 'lucide-react-native';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

export type CategoryAccent = 'contact' | 'work' | 'location' | 'personal' | 'digital' | 'calendar' | 'notes';

function accentColor(category: CategoryAccent, c: ThemePalette): string {
  switch (category) {
    case 'contact':  return c.primary;
    case 'work':     return c.calendar.orange;
    case 'location': return c.calendar.green;
    case 'personal': return c.calendar.pink;
    case 'digital':  return c.calendar.teal;
    case 'calendar': return c.calendar.indigo;
    case 'notes':    return c.calendar.purple;
  }
}

interface FieldBlockProps {
  title: string;
  category?: CategoryAccent;
  icon?: React.ReactNode;
  onAdd?: () => void;
  addLabel?: string;
  children?: React.ReactNode;
}

export default function FieldBlock({
  title, category = 'contact', icon, onAdd, addLabel, children,
}: FieldBlockProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const accent = accentColor(category, c);
  return (
    <View style={[styles.block, { borderLeftColor: accent }]}>
      <View style={styles.header}>
        {icon}
        <Text style={styles.title}>{title}</Text>
        <View style={{ flex: 1 }} />
        {onAdd && (
          <Pressable onPress={onAdd} hitSlop={8} style={styles.addBtn}>
            <Plus size={14} color={c.primary} />
            {!!addLabel && <Text style={styles.addLabel}>{addLabel}</Text>}
          </Pressable>
        )}
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

interface FieldRowProps {
  onRemove?: () => void;
  children: React.ReactNode;
}

export function FieldRow({ onRemove, children }: FieldRowProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>{children}</View>
      {onRemove && (
        <Pressable onPress={onRemove} hitSlop={8} style={styles.removeBtn}>
          <X size={14} color={c.textMuted} />
        </Pressable>
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    block: {
      marginHorizontal: spacing.lg,
      marginBottom: spacing.md,
      paddingLeft: spacing.md,
      paddingRight: spacing.sm,
      paddingVertical: spacing.sm,
      borderLeftWidth: 3,
      borderRadius: radius.sm,
      backgroundColor: c.card,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginBottom: spacing.sm,
    },
    title: { ...typography.bodySemibold, color: c.text },
    addBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.full,
      backgroundColor: c.primaryBg,
    },
    addLabel: { ...typography.caption, color: c.primary },
    body: { gap: spacing.sm },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    removeBtn: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.full,
      backgroundColor: c.surface,
      marginTop: 4,
    },
  });
}
