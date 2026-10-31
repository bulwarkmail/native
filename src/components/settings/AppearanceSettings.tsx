import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore, type ThemeMode, type Density } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { setPendingSettingsTab } from '../../navigation/pending-settings-tab';
import { densityPreviewConfig } from './density-preview';

type Theme = ThemeMode;

const PREVIEW_ROWS = [
  { unread: true, sender: 'Alice Johnson', subject: 'Project update - Q1 roadmap', preview: 'Here are the latest numbers from…' },
  { unread: false, sender: 'Bob Smith', subject: 'Re: Meeting notes', preview: 'Thanks, will review and get back...' },
  { unread: true, sender: 'Carol Lee', subject: 'Invoice #4092', preview: 'Please find attached the invoice…' },
];

function DensityPreview({ density }: { density: Density }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const showPreview = useSettingsStore((s) => s.showPreview);
  const cfg = densityPreviewConfig(density, showPreview);
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
                row.unread ? { color: c.text, fontWeight: '500' } : { color: c.textSecondary },
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
  const t = useLocaleStore((s) => s.t);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const density = useSettingsStore((s) => s.density);
  const setDensity = useSettingsStore((s) => s.setDensity);
  const showToolbarLabels = useSettingsStore((s) => s.showToolbarLabels);
  const setShowToolbarLabels = useSettingsStore((s) => s.setShowToolbarLabels);
  const senderFavicons = useSettingsStore((s) => s.senderFavicons);
  const setSenderFavicons = useSettingsStore((s) => s.setSenderFavicons);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);

  React.useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  return (
    <SettingsSection
      title={t('settings.appearance.title', "Appearance")}
      description={t('settings.appearance.description_mobile', 'Customize how the app looks')}
    >
      <SettingItem label={t('settings.appearance.theme.label', "Theme")} description={t('settings.appearance.theme.description', "Choose your preferred color scheme")}>
        <RadioGroup
          value={theme}
          onChange={(v) => setTheme(v as Theme)}
          options={[
            { value: 'light', label: t('settings.appearance.theme.light', "Light") },
            { value: 'dark', label: t('settings.appearance.theme.dark', "Dark") },
            { value: 'system', label: t('settings.appearance.theme.system', "System") },
          ]}
        />
      </SettingItem>

      {/* Text size and motion moved to Settings > Accessibility. */}
      <SettingItem
        label={t('settings.appearance.accessibility_link.label', 'Text size and motion')}
        description={t('settings.appearance.accessibility_link.description_mobile', 'Text size, reduced motion and the accessibility presets are on the Accessibility page.')}
        onPress={() => setPendingSettingsTab('accessibility')}
        link="page"
      />

      <View>
        <SettingItem label={t('settings.appearance.list_density.label', "Density")} description={t('settings.appearance.list_density.description', "Control spacing and padding across the UI")} noBorder />
        <RadioGroup
          value={density}
          onChange={(v) => setDensity(v as Density)}
          options={[
            { value: 'extra-compact', label: t('settings.appearance.list_density.extra_compact', "Extra Compact") },
            { value: 'compact', label: t('settings.appearance.list_density.compact', "Compact") },
            { value: 'regular', label: t('settings.appearance.list_density.regular', "Regular") },
            { value: 'comfortable', label: t('settings.appearance.list_density.comfortable', "Comfortable") },
          ]}
        />
        <DensityPreview density={density} />
        <View style={styles.divider} />
      </View>

      <SettingItem label={t('settings.appearance.toolbar_labels.label', "Show Toolbar Labels")} description={t('settings.appearance.toolbar_labels.description_mobile', "Display text labels next to toolbar icons.")}>
        <ToggleSwitch checked={showToolbarLabels} onChange={setShowToolbarLabels} />
      </SettingItem>

      <SettingItem
        label={t('settings.advanced.sender_favicons.label', 'Sender Favicons')}
        description={t('settings.advanced.sender_favicons.description', 'Show website icons as profile pictures for business senders')}
        noBorder
      >
        <ToggleSwitch checked={senderFavicons} onChange={setSenderFavicons} />
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
    color: c.textMuted,
  },
  divider: {
    height: 1,
    backgroundColor: c.border,
    marginTop: spacing.md,
  },
});
}
