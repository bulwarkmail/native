import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Plus, X } from 'lucide-react-native';
import { colors, spacing, radius, typography } from '../../theme/tokens';

export type CategoryAccent = 'contact' | 'work' | 'location' | 'personal' | 'digital' | 'calendar' | 'notes';

const ACCENT_COLORS: Record<CategoryAccent, string> = {
  contact: colors.primary,
  work: colors.calendar.orange,
  location: colors.calendar.green,
  personal: colors.calendar.pink,
  digital: colors.calendar.teal,
  calendar: colors.calendar.indigo,
  notes: colors.calendar.purple,
};

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
  const accent = ACCENT_COLORS[category];
  return (
    <View style={[styles.block, { borderLeftColor: accent }]}>
      <View style={styles.header}>
        {icon}
        <Text style={styles.title}>{title}</Text>
        <View style={{ flex: 1 }} />
        {onAdd && (
          <Pressable onPress={onAdd} hitSlop={8} style={styles.addBtn}>
            <Plus size={14} color={colors.primary} />
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
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>{children}</View>
      {onRemove && (
        <Pressable onPress={onRemove} hitSlop={8} style={styles.removeBtn}>
          <X size={14} color={colors.textMuted} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    paddingVertical: spacing.sm,
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  title: { ...typography.bodySemibold, color: colors.text },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: colors.primaryBg,
  },
  addLabel: { ...typography.caption, color: colors.primary },
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
    backgroundColor: colors.surface,
    marginTop: 4,
  },
});
