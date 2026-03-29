import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { colors, spacing, radius, typography } from '../theme/tokens';

interface CardProps {
  children: React.ReactNode;
  style?: ViewStyle;
}

/**
 * Matches webmail card component:
 * - bg-card rounded-lg border border-border
 * - card-foreground for text
 */
export function Card({ children, style }: CardProps) {
  return <View style={[styles.card, style]}>{children}</View>;
}

interface SectionHeaderProps {
  title: string;
  description?: string;
}

/**
 * Matches webmail SettingsSection header:
 * - text-lg font-medium for title
 * - text-sm text-muted-foreground for description
 */
export function SectionHeader({ title, description }: SectionHeaderProps) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {description && <Text style={styles.sectionDescription}>{description}</Text>}
    </View>
  );
}

interface SettingItemRowProps {
  label: string;
  description?: string;
  right?: React.ReactNode;
  icon?: React.ReactNode;
  iconBg?: string;
  bottomBorder?: boolean;
}

/**
 * Matches webmail SettingItem:
 * - flex items-start justify-between py-3 border-b border-border
 * - label: text-sm font-medium text-foreground
 * - description: text-xs text-muted-foreground mt-1
 */
export function SettingItemRow({ label, description, right, icon, iconBg, bottomBorder = true }: SettingItemRowProps) {
  return (
    <View style={[styles.settingRow, bottomBorder && styles.settingRowBorder]}>
      {icon && (
        <View style={[styles.settingIcon, iconBg ? { backgroundColor: iconBg } : undefined]}>
          {icon}
        </View>
      )}
      <View style={styles.settingContent}>
        <Text style={styles.settingLabel}>{label}</Text>
        {description && <Text style={styles.settingDescription}>{description}</Text>}
      </View>
      {right && <View style={styles.settingRight}>{right}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,          // rounded-lg
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  sectionHeader: {
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  sectionTitle: {
    ...typography.h3,                 // text-lg font-medium
    color: colors.text,
  },
  sectionDescription: {
    ...typography.body,
    color: colors.mutedForeground,    // text-muted-foreground
    marginTop: 4,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,      // py-3 = 12px
    paddingHorizontal: spacing.md,
    gap: spacing.md,
  },
  settingRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border, // border-b border-border
  },
  settingIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingContent: {
    flex: 1,
    paddingRight: spacing.lg,        // pr-4
  },
  settingLabel: {
    ...typography.bodyMedium,        // text-sm font-medium text-foreground
    color: colors.text,
  },
  settingDescription: {
    ...typography.caption,           // text-xs text-muted-foreground
    color: colors.mutedForeground,
    marginTop: 2,
  },
  settingRight: {
    flexShrink: 0,
  },
});
