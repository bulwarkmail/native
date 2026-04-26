import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Check } from 'lucide-react-native';
import { SettingsSection, SettingItem } from './settings-section';
import { colors, spacing, radius, typography } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { SUPPORTED_LOCALES, detectDeviceLocale, type LocaleCode } from '../../i18n';

export function LanguageSettings() {
  const override = useLocaleStore((s) => s.override);
  const setOverride = useLocaleStore((s) => s.setOverride);
  const hydrated = useLocaleStore((s) => s.hydrated);
  const hydrate = useLocaleStore((s) => s.hydrate);
  const t = useLocaleStore((s) => s.t);

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  const deviceCode = detectDeviceLocale();
  const selected: LocaleCode | 'system' = override ?? 'system';

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
        {active ? <Check size={16} color={colors.primary} /> : null}
      </Pressable>
    );
  };

  const deviceLabel =
    SUPPORTED_LOCALES.find((l) => l.code === deviceCode)?.label ?? 'English';

  return (
    <SettingsSection
      title={t('settings.appearance.language.label', 'Language')}
      description={t('settings.appearance.language.description', 'Choose your preferred language')}
    >
      <SettingItem
        label={t('settings.appearance.language.label', 'Language')}
        description={t('settings.appearance.language.description', 'Choose your preferred language')}
        noBorder
      />
      <View style={styles.list}>
        {renderRow('system', `System default (${deviceLabel})`)}
        <View style={styles.divider} />
        {SUPPORTED_LOCALES.map((l) => renderRow(l.code, l.label))}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  list: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.background },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  rowPressed: { backgroundColor: colors.muted },
  divider: { height: 1, backgroundColor: colors.border, marginHorizontal: spacing.md },
  label: { ...typography.body, color: colors.text },
  sublabel: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
});
