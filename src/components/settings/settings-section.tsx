import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Modal,
  ScrollView,
  ViewStyle,
} from 'react-native';
import { FlaskConical, Lock, ChevronDown, Check } from 'lucide-react-native';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import ToggleSwitchComponent from '../ToggleSwitch';
import { useLocaleStore } from '../../stores/locale-store';
import { useSearchHighlight } from './search-highlight';

/**
 * Mirrors webmail settings-section.tsx:
 * - SettingsSection: space-y-4, with experimental banner, h3 title + description
 * - SettingItem: flex items-start justify-between py-3 border-b border-border
 * - ToggleSwitch: h-6 w-11
 * - Select: rounded-md bg-muted border text-sm px-3 py-1.5
 * - RadioGroup: flex gap-1.5, pill buttons
 */

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  experimental?: boolean;
  experimentalDescription?: string;
}

export function SettingsSection({
  title,
  description,
  children,
  experimental,
  experimentalDescription,
}: SettingsSectionProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const highlight = useSearchHighlight(title);
  return (
    <View style={styles.section}>
      {experimental && (
        <View style={styles.experimentalBanner}>
          <FlaskConical size={20} color={c.warning} />
          <View style={{ flex: 1 }}>
            <Text style={styles.experimentalTitle}>{t('settings.experimental.title', 'Experimental Feature')}</Text>
            {experimentalDescription && (
              <Text style={styles.experimentalDesc}>{experimentalDescription}</Text>
            )}
          </View>
        </View>
      )}
      <View ref={highlight.ref} onLayout={highlight.onLayout} style={highlight.highlighted && styles.searchHighlight}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {description && <Text style={styles.sectionDescription}>{description}</Text>}
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

interface SettingItemProps {
  label: string;
  description?: string;
  children?: React.ReactNode;
  locked?: boolean;
  noBorder?: boolean;
}

export function SettingItem({
  label,
  description,
  children,
  locked,
  noBorder,
}: SettingItemProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const highlight = useSearchHighlight(label);
  return (
    <View
      ref={highlight.ref}
      onLayout={highlight.onLayout}
      style={[styles.settingItem, !noBorder && styles.settingItemBorder, locked && styles.locked, highlight.highlighted && styles.searchHighlight]}
    >
      <View style={styles.settingContent}>
        <View style={styles.settingLabelRow}>
          <Text style={styles.settingLabel}>{label}</Text>
          {locked && <Lock size={12} color={c.mutedForeground} />}
        </View>
        {description && <Text style={styles.settingDescription}>{description}</Text>}
      </View>
      {children && <View style={styles.settingRight}>{children}</View>}
    </View>
  );
}

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}

export function ToggleSwitch({ checked, onChange, disabled }: ToggleSwitchProps) {
  return (
    <ToggleSwitchComponent
      value={checked}
      onValueChange={onChange}
      disabled={disabled}
    />
  );
}

interface RadioGroupProps {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  style?: ViewStyle;
}

export function RadioGroup({ value, onChange, options, style }: RadioGroupProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={[styles.radioGroup, style]} accessibilityRole="radiogroup">
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            accessibilityLabel={opt.label}
            style={[
              styles.radioOption,
              selected ? styles.radioSelected : styles.radioUnselected,
            ]}
          >
            <Text style={[
              styles.radioText,
              selected ? styles.radioTextSelected : styles.radioTextUnselected,
            ]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  style?: ViewStyle;
}

export function Select({ value, onChange, options, style }: SelectProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <Pressable
        style={[styles.select, style]}
        onPress={() => setOpen(true)}
        accessibilityRole="combobox"
        accessibilityLabel={current?.label ?? ''}
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.selectText}>{current?.label ?? ''}</Text>
        <ChevronDown size={14} color={c.mutedForeground} />
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setOpen(false)}>
          <View style={styles.modalContent}>
            <ScrollView>
              {options.map((opt) => {
                const selected = opt.value === value;
                return (
                  <Pressable
                    key={opt.value}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected }}
                    style={({ pressed }) => [
                      styles.selectItem,
                      pressed && styles.selectItemPressed,
                    ]}
                    onPress={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    <Text style={styles.selectItemText}>{opt.label}</Text>
                    {selected && <Check size={16} color={c.primary} />}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  section: {
    gap: spacing.lg,
  },
  sectionBody: {
    gap: spacing.lg,
  },
  sectionTitle: {
    ...typography.h3,
    color: c.text,
  },
  sectionDescription: {
    ...typography.body,
    color: c.mutedForeground,
    marginTop: 4,
  },
  experimentalBanner: {
    flexDirection: 'row',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: c.warning,
    backgroundColor: c.warningBg,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  experimentalTitle: {
    ...typography.bodyMedium,
    color: c.text,
  },
  experimentalDesc: {
    ...typography.caption,
    color: c.textSecondary,
    marginTop: 2,
  },
  settingItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  settingItemBorder: {
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  locked: {
    opacity: 0.6,
  },
  settingContent: {
    flex: 1,
    paddingRight: spacing.lg,
  },
  settingLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  settingLabel: {
    ...typography.bodyMedium,
    color: c.text,
  },
  settingDescription: {
    ...typography.caption,
    color: c.mutedForeground,
    marginTop: 2,
  },
  settingRight: {
    flexShrink: 0,
  },
  // A row opened from Settings search. The negative margin keeps the
  // content where it was while the tint gets some room around it.
  searchHighlight: {
    backgroundColor: c.selection,
    borderRadius: radius.sm,
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  radioGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  radioOption: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
  radioSelected: {
    backgroundColor: c.primary,
  },
  radioUnselected: {
    backgroundColor: c.muted,
  },
  radioText: {
    ...typography.caption,
  },
  radioTextSelected: {
    color: c.primaryForeground,
    fontWeight: '500',
  },
  radioTextUnselected: {
    color: c.text,
  },
  select: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: c.muted,
    borderWidth: 1,
    borderColor: c.border,
    minWidth: 120,
  },
  selectText: {
    ...typography.body,
    color: c.text,
    flex: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  modalContent: {
    width: '100%',
    maxWidth: 320,
    maxHeight: '70%',
    backgroundColor: c.popover,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: spacing.sm,
  },
  selectItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  selectItemPressed: {
    backgroundColor: c.accent,
  },
  selectItemText: {
    ...typography.body,
    color: c.text,
  },
  });
}
