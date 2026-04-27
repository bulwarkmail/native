import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore, type ThemeMode, type FontSize, type Density } from '../../stores/settings-store';

type Theme = ThemeMode;

const DENSITY_PREVIEW: Record<Density, { py: number; gap: number; showAvatar: boolean; showPreview: boolean }> = {
  'extra-compact': { py: 2, gap: 6, showAvatar: false, showPreview: false },
  compact: { py: 4, gap: 8, showAvatar: true, showPreview: false },
  regular: { py: 10, gap: 12, showAvatar: true, showPreview: true },
  comfortable: { py: 16, gap: 16, showAvatar: true, showPreview: true },
};

const PREVIEW_ROWS = [
  { unread: true, sender: 'Alice Johnson', subject: 'Project update - Q1 roadmap', preview: 'Here are the latest numbers from…' },
  { unread: false, sender: 'Bob Smith', subject: 'Re: Meeting notes', preview: 'Thanks, will review and get back...' },
  { unread: true, sender: 'Carol Lee', subject: 'Invoice #4092', preview: 'Please find attached the invoice…' },
];

function DensityPreview({ density }: { density: Density }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const cfg = DENSITY_PREVIEW[density];
  return (
    <View style={styles.densityPreview}>
      {PREVIEW_ROWS.map((row, i) => (
        <View
          key={i}
          style={[
            styles.densityRow,
            {
              paddingVertical: cfg.py,
              gap: cfg.gap,
              borderBottomWidth: i < PREVIEW_ROWS.length - 1 ? 1 : 0,
            },
          ]}
        >
          {cfg.showAvatar && (
            <View style={[
              styles.densityAvatar,
              density === 'comfortable' ? { width: 32, height: 32 } : { width: 24, height: 24 },
            ]} />
          )}
          <View style={{ flex: 1 }}>
            <View style={styles.densityHeader}>
              <Text
                style={[
                  styles.densitySender,
                  row.unread ? { color: c.text, fontWeight: '600' } : { color: c.mutedForeground },
                ]}
                numberOfLines={1}
              >
                {row.sender}
              </Text>
              <Text style={styles.densityTime}>12:00</Text>
            </View>
            <Text
              style={[
                styles.densitySubject,
                row.unread ? { color: c.text, fontWeight: '500' } : { color: 'rgba(250,250,250,0.8)' },
              ]}
              numberOfLines={1}
            >
              {row.subject}
            </Text>
            {cfg.showPreview && (
              <Text style={styles.densityPreviewText} numberOfLines={1}>
                {row.preview}
              </Text>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

export function AppearanceSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const density = useSettingsStore((s) => s.density);
  const setDensity = useSettingsStore((s) => s.setDensity);
  const showToolbarLabels = useSettingsStore((s) => s.showToolbarLabels);
  const setShowToolbarLabels = useSettingsStore((s) => s.setShowToolbarLabels);
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled);
  const setAnimationsEnabled = useSettingsStore((s) => s.setAnimationsEnabled);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);

  React.useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  return (
    <SettingsSection title="Appearance" description="Customize how the interface looks and feels.">
      <SettingItem label="Theme" description="Choose between light, dark, or system theme.">
        <RadioGroup
          value={theme}
          onChange={(v) => setTheme(v as Theme)}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'system', label: 'System' },
          ]}
        />
      </SettingItem>

      <SettingItem label="Font Size" description="Adjust text size.">
        <RadioGroup
          value={fontSize}
          onChange={(v) => setFontSize(v as FontSize)}
          options={[
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
          ]}
        />
      </SettingItem>

      <View>
        <SettingItem label="List Density" description="How tight the email list is packed." noBorder />
        <RadioGroup
          value={density}
          onChange={(v) => setDensity(v as Density)}
          options={[
            { value: 'extra-compact', label: 'Extra' },
            { value: 'compact', label: 'Compact' },
            { value: 'regular', label: 'Regular' },
            { value: 'comfortable', label: 'Comfy' },
          ]}
        />
        <DensityPreview density={density} />
        <View style={styles.divider} />
      </View>

      <SettingItem label="Toolbar Labels" description="Show text labels on toolbar buttons.">
        <ToggleSwitch checked={showToolbarLabels} onChange={setShowToolbarLabels} />
      </SettingItem>

      <SettingItem label="Animations" description="Enable or disable interface animations.">
        <ToggleSwitch checked={animationsEnabled} onChange={setAnimationsEnabled} />
      </SettingItem>
    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  densityPreview: {
    marginTop: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
    backgroundColor: c.background,
  },
  densityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderBottomColor: c.border,
  },
  densityAvatar: {
    borderRadius: radius.full,
    backgroundColor: c.muted,
  },
  densityHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  densitySender: {
    ...typography.caption,
    flex: 1,
  },
  densityTime: {
    fontSize: 10,
    color: c.mutedForeground,
  },
  densitySubject: {
    ...typography.caption,
  },
  densityPreviewText: {
    fontSize: 11,
    color: 'rgba(161,161,170,0.7)',
  },
  divider: {
    height: 1,
    backgroundColor: c.border,
    marginTop: spacing.md,
  },
});
}
