import React from 'react';
import { Platform, View } from 'react-native';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { spacing } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { APP_FONTS, FONT_SIZES, useSettingsStore, type AppFont, type FontSize } from '../../stores/settings-store';
import { uiFontsBundled } from '../../theme/reading-fonts';
import { toast } from '../../stores/toast-store';
import {
  ACCESSIBILITY_PRESET_IDS,
  applyPresetChanges,
  presetChanges,
  undoPresetChanges,
  type AccessibilityPresetId,
} from '../../lib/accessibility-presets';
import { TOAST_DURATION_CHOICES } from '../../lib/toast-duration';

// Font names are names: the same in every language (webmail
// accessibility-settings.tsx).
const FONT_NAMES: Record<Exclude<AppFont, 'default'>, string> = {
  atkinson: 'Atkinson Hyperlegible',
  lexend: 'Lexend',
  opendyslexic: 'OpenDyslexic',
};

// Percentages read the same in every language the app has.
const TEXT_SIZE_LABELS: Record<FontSize, string> = {
  small: '87.5%',
  medium: '100%',
  large: '112.5%',
  'x-large': '125%',
  'xx-large': '150%',
  'xxx-large': '175%',
  huge: '200%',
};

type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

// Literal keys, so the harvest script and the key test see them.
function presetCopy(id: AccessibilityPresetId, t: Translate): { label: string; description: string } {
  switch (id) {
    case 'screen-reader':
      return {
        label: t('settings.accessibility.presets.screen-reader.label', 'Screen reader'),
        description: t('settings.accessibility.presets.screen-reader.description_mobile', 'No conversation grouping, so every message is a row of its own.'),
      };
    case 'low-vision':
      return {
        label: t('settings.accessibility.presets.low-vision.label', 'Low vision'),
        description: t('settings.accessibility.presets.low-vision.description_mobile', 'Text at 150% and labels under the toolbar icons.'),
      };
    case 'dyslexia':
      return {
        label: t('settings.accessibility.presets.dyslexia.label', 'Dyslexia'),
        description: t('settings.accessibility.presets.dyslexia.description_mobile', 'Atkinson Hyperlegible as the font, also for plain-text messages.'),
      };
    case 'motion':
      return {
        label: t('settings.accessibility.presets.motion.label', 'Motion and seizure safe'),
        description: t('settings.accessibility.presets.motion.description_mobile', 'No animations or sliding transitions.'),
      };
  }
}

/**
 * Settings > Accessibility (webmail components/settings/accessibility-settings.tsx):
 * the presets a phone can apply, text size, motion, and the timing and
 * confirmation options. Reduce motion also follows the system setting
 * (theme/dynamic useShouldAnimate).
 */
export function AccessibilitySettings() {
  const t = useLocaleStore((s) => s.t);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const update = useSettingsStore((s) => s.updateSetting);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const appFont = useSettingsStore((s) => s.appFont);
  const colorBlindPalette = useSettingsStore((s) => s.colorBlindPalette);
  const plainLanguage = useSettingsStore((s) => s.plainLanguage);
  const animationsEnabled = useSettingsStore((s) => s.animationsEnabled);
  const toastDuration = useSettingsStore((s) => s.toastDuration);
  const sendConfirmation = useSettingsStore((s) => s.sendConfirmation);
  const confirmDelete = useSettingsStore((s) => s.confirmDelete);
  const confirmArchive = useSettingsStore((s) => s.confirmArchive);

  React.useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const presetName = (id: AccessibilityPresetId) => presetCopy(id, t).label;

  const applyPreset = (id: AccessibilityPresetId) => {
    const name = presetName(id);
    const changes = presetChanges(id, useSettingsStore.getState());
    if (changes.length === 0) {
      toast.info(t('settings.accessibility.presets.nothing_changed', '{name}: your settings already match.', { name }));
      return;
    }
    applyPresetChanges(changes, update);
    toast.success(
      t('settings.accessibility.presets.applied_mobile', '{name} changed {count, plural, one {# setting} other {# settings}}', {
        name,
        count: changes.length,
      }),
      {
        action: {
          label: t('settings.accessibility.presets.undo', 'Undo'),
          onPress: () => undoPresetChanges(changes, useSettingsStore.getState(), update),
        },
      },
    );
  };

  const durationLabel = (value: number) => {
    if (value < 0) return t('settings.accessibility.toast_duration.automatic', 'Automatic (longer with a screen reader)');
    if (value === 0) return t('settings.accessibility.toast_duration.until_closed', 'Until I close them');
    return t('settings.accessibility.toast_duration.seconds', '{seconds} seconds', { seconds: value });
  };

  return (
    <View style={{ gap: spacing.xxxl }}>
      <SettingsSection
        title={t('settings.accessibility.presets.title', 'Presets')}
        description={t('settings.accessibility.presets.description', 'Each preset changes several settings at once. Afterwards they are normal settings you can change one by one.')}
      >
        {ACCESSIBILITY_PRESET_IDS.map((id, i) => (
          <SettingItem
            key={id}
            label={presetName(id)}
            description={presetCopy(id, t).description}
            noBorder={i === ACCESSIBILITY_PRESET_IDS.length - 1}
          >
            <Button
              size="sm"
              variant="outline"
              onPress={() => applyPreset(id)}
              accessibilityLabel={t('settings.accessibility.presets.apply_named', 'Apply {name}', { name: presetName(id) })}
            >
              {t('settings.accessibility.presets.apply', 'Apply')}
            </Button>
          </SettingItem>
        ))}
      </SettingsSection>

      <SettingsSection title={t('settings.accessibility.sections.text', 'Text and reading')}>
        <SettingItem
          label={t('settings.accessibility.text_size.label', 'Text size')}
          description={t('settings.accessibility.text_size.description_mobile', "Scales the app's text on top of your phone's text size. 100% is your phone's size.")}
        >
          <Select
            value={fontSize}
            onChange={(v) => update('fontSize', v as FontSize)}
            options={FONT_SIZES.map((size) => ({ value: size, label: TEXT_SIZE_LABELS[size] }))}
          />
        </SettingItem>
        <SettingItem
          label={t('settings.accessibility.font.label', 'Font')}
          description={uiFontsBundled(Platform.OS)
            ? t('settings.accessibility.font.description', 'Atkinson Hyperlegible and Lexend are designed to be easy to tell apart; OpenDyslexic helps some people with dyslexia. They cover Latin script.')
            : t('settings.accessibility.font.description_ios', 'Atkinson Hyperlegible and Lexend are designed to be easy to tell apart; OpenDyslexic helps some people with dyslexia. On this device the font is used for plain-text messages.')}
        >
          <Select
            value={appFont}
            onChange={(v) => update('appFont', v as AppFont)}
            options={APP_FONTS.map((font) => ({
              value: font,
              label: font === 'default' ? t('settings.accessibility.font.default', 'Theme font') : FONT_NAMES[font],
            }))}
          />
        </SettingItem>
        <SettingItem
          label={t('settings.accessibility.plain_language.label', 'Plain language')}
          description={t('settings.accessibility.plain_language.description_mobile', 'Simpler wording for settings and error messages. Available in English and German.')}
          noBorder
        >
          <ToggleSwitch
            checked={plainLanguage}
            onChange={(v) => update('plainLanguage', v)}
            accessibilityLabel={t('settings.accessibility.plain_language.label', 'Plain language')}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t('settings.accessibility.sections.contrast', 'Colour and contrast')}>
        <SettingItem
          label={t('settings.accessibility.cvd_palette.label', 'Colour-blind-safe colours')}
          description={t('settings.accessibility.cvd_palette.description_mobile', 'Uses tag and calendar colours that stay distinct with red-green or blue-yellow colour blindness.')}
          noBorder
        >
          <ToggleSwitch
            checked={colorBlindPalette}
            onChange={(v) => update('colorBlindPalette', v)}
            accessibilityLabel={t('settings.accessibility.cvd_palette.label', 'Colour-blind-safe colours')}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t('settings.accessibility.sections.motion', 'Motion')}>
        <SettingItem
          label={t('settings.accessibility.reduce_motion.label', 'Reduce motion')}
          description={t('settings.accessibility.reduce_motion.description_mobile', "Turns off sliding panels and transitions. The app also does this when reduced motion is on in your phone's settings.")}
          noBorder
        >
          <ToggleSwitch
            checked={!animationsEnabled}
            onChange={(reduce) => update('animationsEnabled', !reduce)}
            accessibilityLabel={t('settings.accessibility.reduce_motion.label', 'Reduce motion')}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t('settings.accessibility.sections.timing', 'Timing and mistakes')}>
        <SettingItem
          label={t('settings.accessibility.toast_duration.label', 'Notification duration')}
          description={t('settings.accessibility.toast_duration.description', 'How long messages such as "Moved to Archive" with their Undo button stay on screen.')}
        >
          <Select
            value={String(toastDuration)}
            onChange={(v) => update('toastDuration', Number(v))}
            options={TOAST_DURATION_CHOICES.map((value) => ({ value: String(value), label: durationLabel(value) }))}
          />
        </SettingItem>
        <SettingItem
          label={t('settings.accessibility.confirm_send.label', 'Confirm before sending')}
          description={t('settings.accessibility.confirm_send.description', 'Asks before a message is sent.')}
        >
          <ToggleSwitch
            checked={sendConfirmation}
            onChange={(v) => update('sendConfirmation', v)}
            accessibilityLabel={t('settings.accessibility.confirm_send.label', 'Confirm before sending')}
          />
        </SettingItem>
        <SettingItem
          label={t('settings.accessibility.confirm_delete.label', 'Confirm before deleting')}
          description={t('settings.accessibility.confirm_delete.description', 'Asks before a message is deleted, also for single messages.')}
        >
          <ToggleSwitch
            checked={confirmDelete}
            onChange={(v) => update('confirmDelete', v)}
            accessibilityLabel={t('settings.accessibility.confirm_delete.label', 'Confirm before deleting')}
          />
        </SettingItem>
        <SettingItem
          label={t('settings.accessibility.confirm_archive.label', 'Confirm before archiving')}
          description={t('settings.accessibility.confirm_archive.description', 'Asks before a message is archived.')}
          noBorder
        >
          <ToggleSwitch
            checked={confirmArchive}
            onChange={(v) => update('confirmArchive', v)}
            accessibilityLabel={t('settings.accessibility.confirm_archive.label', 'Confirm before archiving')}
          />
        </SettingItem>
      </SettingsSection>

    </View>
  );
}
