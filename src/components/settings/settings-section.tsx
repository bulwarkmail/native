import React, { useContext, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Modal,
  ScrollView,
  ViewStyle,
  type LayoutChangeEvent,
} from 'react-native';
import { FlaskConical, Lock, ChevronDown, ChevronRight, Check, ExternalLink, type AppIcon } from '../icons';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import ToggleSwitchComponent from '../ToggleSwitch';
import { useLocaleStore } from '../../stores/locale-store';
import { useSearchHighlight } from './search-highlight';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';

/**
 * Mirrors webmail settings-section.tsx in the standard theme:
 * - SettingsSection: title 18px medium, description 14px muted, then rows
 * - SettingItem: label 14px medium, description 12px muted, 12 dp vertical
 *   padding, a 1 dp border under each row, the control on the right
 * - ToggleSwitch: 44 x 24
 * - Select: a 36 dp outline button with a chevron, radius 6
 * - RadioGroup: flex gap-1.5, pill buttons
 * Plus SettingsRow, the 56 dp row of the Settings list (icon, title, value).
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

/** Narrowest label column before a row's control moves under the label. */
const STACK_BELOW = 140;

// The label of the SettingItem a control sits in. A switch has no text of
// its own, so without it a screen reader only announces "switch, off".
const SettingLabelContext = React.createContext<string | undefined>(undefined);

interface SettingItemProps {
  label: string;
  description?: string;
  children?: React.ReactNode;
  locked?: boolean;
  noBorder?: boolean;
  /** Makes the whole row a link: to a page (chevron) or out of the app. */
  onPress?: () => void;
  link?: 'page' | 'external';
}

export function SettingItem({
  label,
  description,
  children,
  locked,
  noBorder,
  onPress,
  link = 'page',
}: SettingItemProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const highlight = useSearchHighlight(label);
  // The control sits on the right. When that leaves the label column narrower
  // than STACK_BELOW (a long translation, two buttons), the control moves
  // under the label, as the webmail stacks it on a phone. A new row width
  // (rotation, split view) measures again.
  const [stacked, setStacked] = useState(false);
  const rowWidth = React.useRef(0);
  const onRowLayout = (e: LayoutChangeEvent) => {
    highlight.onLayout(e);
    const width = e.nativeEvent.layout.width;
    if (Math.abs(width - rowWidth.current) > 1) {
      rowWidth.current = width;
      setStacked(false);
    }
  };
  const onContentLayout = (e: LayoutChangeEvent) => {
    if (!stacked && children && e.nativeEvent.layout.width < STACK_BELOW) setStacked(true);
  };
  const rowStyle = [styles.settingItem, stacked && styles.settingItemStacked, !noBorder && styles.settingItemBorder, locked && styles.locked, highlight.highlighted && styles.searchHighlight];
  const body = (
    <>
      <View style={[styles.settingContent, stacked && styles.settingContentStacked]} onLayout={onContentLayout}>
        <View style={styles.settingLabelRow}>
          <Text style={styles.settingLabel}>{label}</Text>
          {locked && <Lock size={12} color={c.mutedForeground} />}
        </View>
        {description && <Text style={styles.settingDescription}>{description}</Text>}
        {locked && <Text style={styles.settingDescription}>{t('settings.org_locked', 'Set by your organisation')}</Text>}
      </View>
      {children && (
        <SettingLabelContext.Provider value={label}>
          {/* A locked setting shows its value but can't be changed. */}
          <View style={styles.settingRight} pointerEvents={locked ? 'none' : 'auto'}>{children}</View>
        </SettingLabelContext.Provider>
      )}
      {onPress && (link === 'external'
        ? <ExternalLink size={16} color={c.mutedForeground} />
        : <ChevronRight size={16} color={c.mutedForeground} />)}
    </>
  );
  if (onPress) {
    return (
      <Pressable
        ref={highlight.ref}
        onLayout={onRowLayout}
        onPress={onPress}
        accessibilityRole={link === 'external' ? 'link' : 'button'}
        style={({ pressed }) => [...rowStyle, pressed && styles.settingItemPressed]}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View ref={highlight.ref} onLayout={onRowLayout} style={rowStyle}>
      {body}
    </View>
  );
}

interface SettingsRowProps {
  icon: AppIcon;
  title: string;
  /** The current value, e.g. "Dark · Standard theme". */
  value?: string | null;
  onPress: () => void;
  disabled?: boolean;
  /** The page open beside the list on a wide window. */
  selected?: boolean;
  /** Sits after the title, e.g. a Badge. */
  badge?: React.ReactNode;
}

/** A row of the Settings list: muted icon, 15px title, 13px current value. */
export function SettingsRow({ icon: Icon, title, value, onPress, disabled, selected, badge }: SettingsRowProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={value ? `${title}, ${value}` : title}
      accessibilityState={{ disabled, selected }}
      style={({ pressed }) => [
        styles.row,
        disabled && styles.rowDisabled,
        !disabled && pressed && styles.rowPressed,
        selected && styles.rowSelected,
      ]}
    >
      <Icon size={20} color={c.mutedForeground} />
      <View style={styles.rowText}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
          {badge}
        </View>
        {value ? <Text style={styles.rowValue} numberOfLines={1}>{value}</Text> : null}
      </View>
    </Pressable>
  );
}

/** A group label in the Settings list: title case, 13px medium, muted. */
export function SettingsGroupLabel({ children }: { children: string }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return <Text style={styles.groupLabel} accessibilityRole="header">{children}</Text>;
}

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Defaults to the label of the enclosing SettingItem. */
  accessibilityLabel?: string;
}

export function ToggleSwitch({ checked, onChange, disabled, accessibilityLabel }: ToggleSwitchProps) {
  const settingLabel = useContext(SettingLabelContext);
  return (
    <ToggleSwitchComponent
      value={checked}
      onValueChange={onChange}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel ?? settingLabel}
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
            hitSlop={{ top: 10, bottom: 10 }}
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
        style={({ pressed }) => [styles.select, pressed && styles.selectPressed, style]}
        onPress={() => setOpen(true)}
        hitSlop={6}
        accessibilityRole="combobox"
        accessibilityLabel={current?.label ?? ''}
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.selectText}>{current?.label ?? ''}</Text>
        <ChevronDown size={14} color={c.text} />
      </Pressable>
      <Modal supportedOrientations={MODAL_ORIENTATIONS}
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable accessible={false} style={styles.modalBackdrop} onPress={() => setOpen(false)}>
          <View style={styles.modalContent}>
            <ScrollView keyboardShouldPersistTaps="handled">
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
    gap: spacing.xs,
  },
  // Rows sit flush; the border under each one separates them.
  sectionBody: { marginTop: spacing.xs },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '500',
    lineHeight: 26,
    color: c.text,
  },
  sectionDescription: {
    ...typography.body,
    color: c.mutedForeground,
    marginTop: 2,
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
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  settingItemPressed: {
    backgroundColor: c.surfaceHover,
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
  },
  // The control under the label instead of beside it (see SettingItem).
  settingItemStacked: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  settingContentStacked: {
    flex: 0,
    alignSelf: 'stretch',
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
    marginTop: 3,
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
    minHeight: 36,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.border,
  },
  selectPressed: {
    backgroundColor: c.muted,
  },
  selectText: {
    ...typography.body,
    color: c.text,
    flexShrink: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  rowPressed: { backgroundColor: c.surfaceHover },
  rowSelected: { backgroundColor: c.muted },
  rowDisabled: { opacity: 0.55 },
  rowText: { flex: 1, gap: 2 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowTitle: { fontSize: 15, lineHeight: 20, color: c.text, flexShrink: 1 },
  rowValue: { fontSize: 13, lineHeight: 18, color: c.mutedForeground },
  groupLabel: {
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
    color: c.mutedForeground,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
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
