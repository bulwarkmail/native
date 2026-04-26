import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { PlayCircle } from 'lucide-react-native';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { colors, spacing, radius, typography } from '../../theme/tokens';

type Theme = 'light' | 'dark' | 'system';
type FontSize = 'small' | 'medium' | 'large';
type Density = 'extra-compact' | 'compact' | 'regular' | 'comfortable';
type ToolbarPosition = 'top' | 'below-subject';

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
                  row.unread ? { color: colors.text, fontWeight: '600' } : { color: colors.mutedForeground },
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
                row.unread ? { color: colors.text, fontWeight: '500' } : { color: 'rgba(250,250,250,0.8)' },
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
  const [theme, setTheme] = useState<Theme>('dark');
  const [fontSize, setFontSize] = useState<FontSize>('medium');
  const [density, setDensity] = useState<Density>('regular');
  const [toolbarPosition, setToolbarPosition] = useState<ToolbarPosition>('top');
  const [showToolbarLabels, setShowToolbarLabels] = useState(true);
  const [hideAccountSwitcher, setHideAccountSwitcher] = useState(false);
  const [showRailAccountList, setShowRailAccountList] = useState(false);
  const [colorfulSidebarIcons, setColorfulSidebarIcons] = useState(true);
  const [animationsEnabled, setAnimationsEnabled] = useState(true);
  const [language, setLanguage] = useState('en');

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

      <SettingItem label="Language" description="Interface language.">
        <RadioGroup
          value={language}
          onChange={setLanguage}
          options={[
            { value: 'en', label: 'EN' },
            { value: 'de', label: 'DE' },
            { value: 'fr', label: 'FR' },
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

      <SettingItem label="Toolbar Position" description="Where to place the message toolbar.">
        <RadioGroup
          value={toolbarPosition}
          onChange={(v) => setToolbarPosition(v as ToolbarPosition)}
          options={[
            { value: 'top', label: 'Top' },
            { value: 'below-subject', label: 'Below' },
          ]}
        />
      </SettingItem>

      <SettingItem label="Toolbar Labels" description="Show text labels on toolbar buttons.">
        <ToggleSwitch checked={showToolbarLabels} onChange={setShowToolbarLabels} />
      </SettingItem>

      <SettingItem label="Hide Account Switcher" description="Hide the account switcher from the navigation rail.">
        <ToggleSwitch checked={hideAccountSwitcher} onChange={setHideAccountSwitcher} />
      </SettingItem>

      <SettingItem label="Rail Account List" description="Show all accounts inside the navigation rail.">
        <ToggleSwitch checked={showRailAccountList} onChange={setShowRailAccountList} />
      </SettingItem>

      <SettingItem label="Colorful Sidebar Icons" description="Display sidebar icons with their brand colors.">
        <ToggleSwitch checked={colorfulSidebarIcons} onChange={setColorfulSidebarIcons} />
      </SettingItem>

      <SettingItem label="Animations" description="Enable or disable interface animations.">
        <ToggleSwitch checked={animationsEnabled} onChange={setAnimationsEnabled} />
      </SettingItem>

      <SettingItem label="Restart Tour" description="Replay the onboarding walkthrough.">
        <Button variant="outline" size="sm" icon={<PlayCircle size={14} color={colors.text} />}>
          Restart
        </Button>
      </SettingItem>
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  densityPreview: {
    marginTop: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    backgroundColor: colors.background,
  },
  densityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderBottomColor: colors.border,
  },
  densityAvatar: {
    borderRadius: radius.full,
    backgroundColor: colors.muted,
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
    color: colors.mutedForeground,
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
    backgroundColor: colors.border,
    marginTop: spacing.md,
  },
});
