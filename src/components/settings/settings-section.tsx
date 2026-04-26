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
import { colors, spacing, radius, typography } from '../../theme/tokens';
import ToggleSwitchComponent from '../ToggleSwitch';

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
  return (
    <View style={styles.section}>
      {experimental && (
        <View style={styles.experimentalBanner}>
          <FlaskConical size={20} color="#fbbf24" />
          <View style={{ flex: 1 }}>
            <Text style={styles.experimentalTitle}>Experimental Feature</Text>
            {experimentalDescription && (
              <Text style={styles.experimentalDesc}>{experimentalDescription}</Text>
            )}
          </View>
        </View>
      )}
      <View>
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
  return (
    <View style={[styles.settingItem, !noBorder && styles.settingItemBorder, locked && styles.locked]}>
      <View style={styles.settingContent}>
        <View style={styles.settingLabelRow}>
          <Text style={styles.settingLabel}>{label}</Text>
          {locked && <Lock size={12} color={colors.mutedForeground} />}
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
  return (
    <View style={[styles.radioGroup, style]}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
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
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <Pressable style={[styles.select, style]} onPress={() => setOpen(true)}>
        <Text style={styles.selectText}>{current?.label ?? ''}</Text>
        <ChevronDown size={14} color={colors.mutedForeground} />
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
                    {selected && <Check size={16} color={colors.primary} />}
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

const styles = StyleSheet.create({
  section: {
    gap: spacing.lg,
  },
  sectionBody: {
    gap: spacing.lg,
  },
  sectionTitle: {
    ...typography.h3,
    color: colors.text,
  },
  sectionDescription: {
    ...typography.body,
    color: colors.mutedForeground,
    marginTop: 4,
  },
  experimentalBanner: {
    flexDirection: 'row',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(252, 211, 77, 0.4)',
    backgroundColor: 'rgba(120, 53, 15, 0.25)',
    padding: spacing.md,
    borderRadius: radius.md,
  },
  experimentalTitle: {
    ...typography.bodyMedium,
    color: '#fcd34d',
  },
  experimentalDesc: {
    ...typography.caption,
    color: '#fde68a',
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
    borderBottomColor: colors.border,
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
    color: colors.text,
  },
  settingDescription: {
    ...typography.caption,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  settingRight: {
    flexShrink: 0,
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
    backgroundColor: colors.primary,
  },
  radioUnselected: {
    backgroundColor: colors.muted,
  },
  radioText: {
    ...typography.caption,
  },
  radioTextSelected: {
    color: colors.primaryForeground,
    fontWeight: '500',
  },
  radioTextUnselected: {
    color: colors.text,
  },
  select: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.muted,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 120,
  },
  selectText: {
    ...typography.body,
    color: colors.text,
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
    backgroundColor: colors.popover,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
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
    backgroundColor: colors.accent,
  },
  selectItemText: {
    ...typography.body,
    color: colors.text,
  },
});
