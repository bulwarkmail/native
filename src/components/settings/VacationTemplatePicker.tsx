import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { SettingsSection, SettingItem, Select } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { isValidEmail } from '../../lib/recipients';
import type { OrgVacationTemplate } from '../../lib/org-organisation';
import {
  deputyFieldsNeeded,
  fillVacationTemplate,
  sortedVacationTemplates,
  vacationValues,
  type FilledVacationTemplate,
  type VacationFillInput,
} from '../../lib/vacation-templates';

const NONE = '';

/**
 * "Use a template" on the out-of-office page (webmail
 * components/settings/vacation-template-picker.tsx): the organisation's
 * reply texts. Picking one asks for the deputy first when the text names
 * one, and only "Use this text" fills the fields.
 */
export function VacationTemplatePicker({ library, base, onApply }: {
  library: readonly OrgVacationTemplate[];
  /** Everything but the deputy, from the account and the dates on the page. */
  base: Omit<VacationFillInput, 'deputy' | 'deputyName'>;
  onApply: (filled: FilledVacationTemplate) => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const templates = React.useMemo(() => sortedVacationTemplates(library), [library]);
  const [selectedId, setSelectedId] = React.useState(NONE);
  const [deputy, setDeputy] = React.useState('');
  const [deputyName, setDeputyName] = React.useState('');
  const [tried, setTried] = React.useState(false);
  const selected = templates.find((tpl) => tpl.id === selectedId) ?? null;
  const needs = selected ? deputyFieldsNeeded(selected) : { address: false, name: false };
  const addressError = needs.address && !isValidEmail(deputy.trim());
  const nameError = needs.name && !deputyName.trim();

  if (templates.length === 0) return null;

  const options = [
    { value: NONE, label: t('vacation_templates.pick_placeholder', 'Choose a template') },
    ...templates.map((tpl) => ({ value: tpl.id, label: tpl.category ? `${tpl.category}: ${tpl.name}` : tpl.name })),
  ];

  const apply = () => {
    if (!selected) return;
    if (addressError || nameError) {
      setTried(true);
      return;
    }
    onApply(fillVacationTemplate(selected, vacationValues({ ...base, deputy, deputyName })));
    setSelectedId(NONE);
    setTried(false);
  };

  return (
    <SettingsSection
      title={t('vacation_templates.title', 'Organisation templates')}
      description={t('vacation_templates.description', 'Start from a reply your organisation wrote. You can change the text afterwards.')}
    >
      <SettingItem label={t('vacation_templates.pick_label', 'Use a template')} noBorder={!selected}>
        <Select value={selectedId} onChange={(v) => { setSelectedId(v); setTried(false); }} options={options} />
      </SettingItem>
      {selected && (
        <View style={styles.block} testID="vacation-template-fields">
          {needs.address && (
            <View>
              <Text style={styles.label}>{t('vacation_templates.deputy_label', "Deputy's address")}</Text>
              <TextInput
                value={deputy}
                onChangeText={setDeputy}
                placeholder={t('vacation_templates.deputy_placeholder', 'colleague@example.com')}
                placeholderTextColor={c.mutedForeground}
                accessibilityLabel={t('vacation_templates.deputy_label', "Deputy's address")}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={apply}
                style={[styles.input, tried && addressError && styles.invalid]}
              />
              <Text style={tried && addressError ? styles.error : styles.hint}>
                {tried && addressError
                  ? t('vacation_templates.deputy_missing', "Enter your deputy's address first.")
                  : t('vacation_templates.deputy_hint', 'The reply names this colleague for urgent matters.')}
              </Text>
            </View>
          )}
          {needs.name && (
            <View>
              <Text style={styles.label}>{t('vacation_templates.deputy_name_label', "Deputy's name")}</Text>
              <TextInput
                value={deputyName}
                onChangeText={setDeputyName}
                accessibilityLabel={t('vacation_templates.deputy_name_label', "Deputy's name")}
                onSubmitEditing={apply}
                style={[styles.input, tried && nameError && styles.invalid]}
              />
              {tried && nameError && (
                <Text style={styles.error}>{t('vacation_templates.deputy_name_missing', "Enter your deputy's name first.")}</Text>
              )}
            </View>
          )}
          <View style={styles.applyRow}>
            <Button size="sm" onPress={apply}>{t('vacation_templates.apply', 'Use this text')}</Button>
            <Text style={[styles.hint, styles.applyHint]}>{t('vacation_templates.apply_hint', 'Replaces the subject and text below.')}</Text>
          </View>
        </View>
      )}
    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    block: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    label: { ...typography.bodyMedium, color: c.text, marginBottom: spacing.xs },
    input: {
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.sm,
      backgroundColor: c.muted,
      borderWidth: 1,
      borderColor: c.border,
      color: c.text,
      ...typography.body,
    },
    invalid: { borderColor: c.error },
    hint: { ...typography.caption, color: c.mutedForeground, marginTop: spacing.xs },
    error: { ...typography.caption, color: c.error, marginTop: spacing.xs },
    applyRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.md },
    applyHint: { flex: 1, marginTop: 0 },
  });
}
