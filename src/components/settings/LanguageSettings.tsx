import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Check } from 'lucide-react-native';
import { SettingsSection, SettingItem, RadioGroup, Select } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore, type DateFormat, type DateLocale, type TimeFormat } from '../../stores/settings-store';
import { formatInRegion, formatListDate, formatNumericDate } from '../../lib/date-format';
import { useDateRegion } from '../../lib/use-date-region';
import { AUTO_TIME_ZONE, getDeviceTimeZone } from '../../lib/calendar-timezone';
import { timeZoneOptions } from '../../lib/time-zone-options';
import { SUPPORTED_LOCALES, detectDeviceLocale, type LocaleCode } from '../../i18n';

export function LanguageSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const override = useLocaleStore((s) => s.override);
  const setOverride = useLocaleStore((s) => s.setOverride);
  const locale = useLocaleStore((s) => s.locale);
  const hydrated = useLocaleStore((s) => s.hydrated);
  const hydrate = useLocaleStore((s) => s.hydrate);
  const t = useLocaleStore((s) => s.t);

  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const dateRegion = useDateRegion();
  const update = useSettingsStore((s) => s.updateSetting);

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);
  useEffect(() => { if (!settingsHydrated) void hydrateSettings(); }, [settingsHydrated, hydrateSettings]);

  const deviceCode = detectDeviceLocale();
  const selected: LocaleCode | 'system' = override ?? 'system';

  // Build live preview samples so the user sees what each format looks like.
  const now = new Date();
  const fmtOpts = { ...dateRegion, dateFormat, timeFormat, locale };
  const previewToday = formatListDate(now, fmtOpts);
  const previewWeek = formatListDate(new Date(now.getTime() - 3 * 86400000), fmtOpts);
  const previewOlder = formatListDate(new Date(now.getTime() - 40 * 86400000), fmtOpts);

  // Each region's option shows today's date the way it orders it.
  const regionSample = (dateLocale: DateLocale) =>
    formatNumericDate(now, { locale, dateLocale, timeZone: dateRegion.timeZone });
  const regionOption = (value: DateLocale, label: string) => ({ value, label: `${label} (${regionSample(value)})` });

  // The clock in the chosen zone, so a pick can be checked at a glance.
  const deviceZone = getDeviceTimeZone();
  const zoneOptions = timeZoneOptions(
    deviceZone,
    dateRegion.timeZone,
    t('settings.language_region.time_zone.auto', 'Automatic ({zone})', { zone: deviceZone }),
  );
  const zonePreview = formatInRegion(
    now,
    { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h', timeZoneName: 'short' },
    { locale, timeZone: dateRegion.timeZone },
  );

  const renderRow = (code: LocaleCode | 'system', label: string, sublabel?: string) => {
    const active = selected === code;
    return (
      <Pressable
        key={code}
        onPress={() => setOverride(code === 'system' ? null : (code as LocaleCode))}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>{label}</Text>
          {sublabel ? <Text style={styles.sublabel}>{sublabel}</Text> : null}
        </View>
        {active ? <Check size={16} color={c.primary} /> : null}
      </Pressable>
    );
  };

  const deviceLabel =
    SUPPORTED_LOCALES.find((l) => l.code === deviceCode)?.label ?? 'English';
  const directionChangePending = useLocaleStore((s) => s.directionChangePending);

  return (
    <View style={{ gap: spacing.xxxl }}>
      <SettingsSection
        title={t('settings.appearance.language.label', 'Language')}
        description={t('settings.appearance.language.description', 'Choose your preferred language')}
      >
        <View style={styles.list}>
          {renderRow(
            'system',
            `${t('settings.appearance.language.system_default', 'System default')} (${deviceLabel})`,
          )}
          <View style={styles.divider} />
          {SUPPORTED_LOCALES.map((l) => renderRow(l.code, l.label))}
        </View>
        {directionChangePending && (
          <Text style={styles.hint}>
            {t(
              'settings.appearance.language.restart_for_direction',
              'Restart the app to apply the new text direction.',
            )}
          </Text>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.language_region.date_format.label', 'Date Format')}
        description={t('settings.language_region.date_format.description', 'How dates are shown in the email list')}
      >
        <RadioGroup
          value={dateFormat}
          onChange={(v) => update('dateFormat', v as DateFormat)}
          options={[
            { value: 'smart', label: t('settings.language_region.date_format.smart', 'Smart (locale-aware)') },
            { value: 'relative', label: t('settings.language_region.date_format.relative', 'Relative (1h ago, 2d ago)') },
            { value: 'full', label: t('settings.language_region.date_format.full', 'Always full date') },
          ]}
        />
        <View style={styles.previewBox}>
          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>{t('settings.language_region.date_format.preview_today', 'Today:')}</Text>
            <Text style={styles.previewValue}>{previewToday}</Text>
          </View>
          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>{t('settings.language_region.date_format.preview_this_week', 'This week:')}</Text>
            <Text style={styles.previewValue}>{previewWeek}</Text>
          </View>
          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>{t('settings.language_region.date_format.preview_older', 'Older:')}</Text>
            <Text style={styles.previewValue}>{previewOlder}</Text>
          </View>
        </View>
      </SettingsSection>

      <SettingsSection
        title={t('settings.language_region.date_locale.label', 'Date format region')}
        description={t('settings.language_region.date_locale.description', 'How numeric dates are ordered (day, month, year)')}
      >
        <Select
          value={dateRegion.dateLocale ?? 'auto'}
          onChange={(v) => update('dateLocale', v as DateLocale)}
          accessibilityLabel={t('settings.language_region.date_locale.label', 'Date format region')}
          options={[
            regionOption('auto', t('settings.language_region.date_locale.auto', 'Automatic (match language)')),
            regionOption('iso', t('settings.language_region.date_locale.iso', 'ISO 8601 (YYYY-MM-DD)')),
            regionOption('en-GB', t('settings.language_region.date_locale.dmy', 'Day/Month/Year')),
            regionOption('en-US', t('settings.language_region.date_locale.mdy', 'Month/Day/Year')),
          ]}
        />
      </SettingsSection>

      <SettingsSection
        title={t('settings.language_region.time_format.label', 'Time Format')}
        description={t('settings.language_region.time_format.description', 'Choose between 12-hour or 24-hour clock')}
      >
        <RadioGroup
          value={timeFormat}
          onChange={(v) => update('timeFormat', v as TimeFormat)}
          options={[
            { value: '24h', label: t('settings.language_region.time_format.24h', '24-hour') },
            { value: '12h', label: t('settings.language_region.time_format.12h', '12-hour') },
          ]}
        />
      </SettingsSection>

      <SettingsSection
        title={t('settings.language_region.time_zone.label', 'Time zone')}
        description={t(
          'settings.language_region.time_zone.description_device',
          'Show email and calendar times in this time zone instead of the one your device uses',
        )}
      >
        <Select
          value={dateRegion.timeZone || AUTO_TIME_ZONE}
          onChange={(v) => update('calendarTimeZone', v)}
          accessibilityLabel={t('settings.language_region.time_zone.label', 'Time zone')}
          options={zoneOptions}
        />
        <View style={styles.previewBox}>
          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>{t('settings.language_region.time_zone.preview_now', 'Now:')}</Text>
            <Text style={styles.previewValue}>{zonePreview}</Text>
          </View>
        </View>
      </SettingsSection>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  list: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.background },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  rowPressed: { backgroundColor: c.muted },
  divider: { height: 1, backgroundColor: c.border, marginHorizontal: spacing.md },
  label: { ...typography.body, color: c.text },
  sublabel: { ...typography.caption, color: c.textMuted, marginTop: 2 },
  hint: { ...typography.caption, color: c.warning, marginTop: spacing.sm },
  previewBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: c.muted,
    gap: 4,
  },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  previewLabel: { ...typography.caption, color: c.mutedForeground },
  previewValue: { ...typography.captionMedium, color: c.text },
});
}
