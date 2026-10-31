import React from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Mail, Phone, Image as ImageIcon, X } from '../icons';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import {
  countActiveFilters,
  cycleTri,
  EMPTY_CONTACT_FILTERS,
  type ContactListFilters,
  type TriState,
} from '../../lib/contact-list-filters';

interface Props {
  filters: ContactListFilters;
  onChange: (filters: ContactListFilters) => void;
  onClose: () => void;
}

// The contact list's advanced filters (webmail contact-list.tsx): company,
// job title, location, email domain, birthday month and has email / phone /
// photo, each a three-way toggle (off, must have, must not have).
export function ContactFiltersPanel({ filters, onChange, onClose }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const monthNames = React.useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: 'long' });
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2000, i, 1)));
  }, [locale]);
  const set = <K extends keyof ContactListFilters>(key: K, value: ContactListFilters[K]) =>
    onChange({ ...filters, [key]: value });

  const field = (key: 'organization' | 'jobTitle' | 'location' | 'emailDomain', label: string, placeholder: string) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={filters[key]}
        onChangeText={(v) => set(key, v)}
        placeholder={placeholder}
        placeholderTextColor={c.textMuted}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
    </View>
  );

  const toggle = (key: 'hasEmail' | 'hasPhone' | 'hasPhoto', label: string, icon: React.ReactNode) => {
    const value: TriState = filters[key];
    return (
      <Pressable
        onPress={() => set(key, cycleTri(value))}
        style={[styles.chip, value === true && styles.chipOn, value === false && styles.chipNot]}
        accessibilityRole="button"
        accessibilityState={{ checked: value === null ? false : value === true ? true : 'mixed' }}
      >
        {icon}
        <Text style={[styles.chipText, value === true && styles.chipTextOn, value === false && styles.chipTextNot]}>{label}</Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('contacts.filters.title', 'Advanced filters')}</Text>
        {countActiveFilters(filters) > 0 && (
          <Pressable onPress={() => onChange(EMPTY_CONTACT_FILTERS)} hitSlop={6} accessibilityRole="button">
            <Text style={styles.clear}>{t('contacts.filters.clear', 'Clear')}</Text>
          </Pressable>
        )}
        <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('contacts.filters.close', 'Close')}>
          <X size={16} color={c.textMuted} />
        </Pressable>
      </View>
      <View style={styles.row}>
        {field('organization', t('contacts.filters.organization', 'Company'), t('contacts.filters.organization_placeholder', 'e.g. Acme Corp'))}
        {field('jobTitle', t('contacts.filters.job_title', 'Job title'), t('contacts.filters.job_title_placeholder', 'e.g. Designer'))}
      </View>
      <View style={styles.row}>
        {field('location', t('contacts.filters.location', 'Location'), t('contacts.filters.location_placeholder', 'City or country'))}
        {field('emailDomain', t('contacts.filters.email_domain', 'Email domain'), t('contacts.filters.email_domain_placeholder', 'example.com'))}
      </View>
      <Text style={styles.label}>{t('contacts.filters.birthday_month', 'Birthday in')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.months}>
        <Pressable
          onPress={() => set('birthdayMonth', null)}
          style={[styles.chip, filters.birthdayMonth === null && styles.chipOn]}
          accessibilityRole="radio"
          accessibilityState={{ selected: filters.birthdayMonth === null }}
        >
          <Text style={[styles.chipText, filters.birthdayMonth === null && styles.chipTextOn]}>{t('contacts.filters.any_month', 'Any month')}</Text>
        </Pressable>
        {monthNames.map((name, i) => {
          const active = filters.birthdayMonth === i + 1;
          return (
            <Pressable
              key={name}
              onPress={() => set('birthdayMonth', i + 1)}
              style={[styles.chip, active && styles.chipOn]}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextOn]}>{name}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.toggles}>
        {toggle('hasEmail', t('contacts.filters.has_email', 'Has email'), <Mail size={14} color={c.textMuted} />)}
        {toggle('hasPhone', t('contacts.filters.has_phone', 'Has phone'), <Phone size={14} color={c.textMuted} />)}
        {toggle('hasPhoto', t('contacts.filters.has_photo', 'Has photo'), <ImageIcon size={14} color={c.textMuted} />)}
      </View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    panel: {
      marginHorizontal: spacing.lg,
      marginBottom: spacing.sm,
      padding: spacing.md,
      gap: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    title: { ...typography.bodyMedium, color: c.text, flex: 1 },
    clear: { ...typography.captionMedium, color: c.primary },
    row: { flexDirection: 'row', gap: spacing.sm },
    field: { flex: 1, gap: 2 },
    label: { ...typography.caption, color: c.textMuted },
    input: {
      ...typography.body,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      backgroundColor: c.background,
    },
    months: { gap: spacing.xs },
    toggles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    chipOn: { backgroundColor: c.primaryBg, borderColor: c.primary },
    chipNot: { backgroundColor: c.surface },
    chipText: { ...typography.caption, color: c.textMuted },
    chipTextOn: { color: c.primary },
    chipTextNot: { textDecorationLine: 'line-through' },
  });
}
