import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing, TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSheetDrag } from '../../lib/use-sheet-drag';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import {
  cycleTri,
  EMPTY_CONTACT_FILTERS,
  type ContactListFilters,
  type TriState,
} from '../../lib/contact-filters';

interface Props {
  visible: boolean;
  onClose: () => void;
  filters: ContactListFilters;
  onChange: (next: ContactListFilters) => void;
}

export default function ContactFilterSheet({ visible, onClose, filters, onChange }: Props) {
  const c = useColors();
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const sortByLastName = useSettingsStore((s) => s.sortContactsByLastName);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const monthNames = React.useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: 'long' });
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2000, i, 1)));
  }, [locale]);

  const slideY = React.useRef(new Animated.Value(700)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({ slideY, closedY: 700, onClose });

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 700, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, overlayOpacity]);

  const set = <K extends keyof ContactListFilters>(key: K, value: ContactListFilters[K]) =>
    onChange({ ...filters, [key]: value });

  const textField = (
    key: 'organization' | 'jobTitle' | 'location' | 'emailDomain',
    label: string,
    placeholder: string,
    extra?: { keyboardType?: 'email-address' },
  ) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor={c.textMuted}
        value={filters[key]}
        onChangeText={(v) => set(key, v)}
        autoCapitalize="none"
        autoCorrect={false}
        {...extra}
      />
    </View>
  );

  const triChip = (key: 'hasEmail' | 'hasPhone' | 'hasPhoto', label: string) => {
    const v: TriState = filters[key];
    return (
      <Pressable
        key={key}
        onPress={() => set(key, cycleTri(v))}
        style={[styles.chip, v === true && styles.chipOn, v === false && styles.chipOff]}
        accessibilityRole="button"
        accessibilityState={{ selected: v !== null }}
      >
        <Text
          style={[
            styles.chipText,
            v === true && styles.chipTextOn,
            v === false && styles.chipTextOff,
          ]}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom, spacing.md), transform: [{ translateY: slideY }] },
        ]}
      >
        <View {...dragHandlers}>
          <View style={styles.handleHit}>
            <View style={styles.handle} />
          </View>
          <View style={styles.header}>
            <Text style={styles.title}>{t('contacts.filters.title', 'Advanced filters')}</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={styles.close}
              accessibilityRole="button"
              accessibilityLabel={t('contacts.filters.close', 'Close')}
            >
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
          {textField('organization', t('contacts.filters.organization', 'Company'), t('contacts.filters.organization_placeholder', 'e.g. Acme Corp'))}
          {textField('jobTitle', t('contacts.filters.job_title', 'Job title'), t('contacts.filters.job_title_placeholder', 'e.g. Designer'))}
          {textField('location', t('contacts.filters.location', 'Location'), t('contacts.filters.location_placeholder', 'City or country'))}
          {textField('emailDomain', t('contacts.filters.email_domain', 'Email domain'), t('contacts.filters.email_domain_placeholder', 'example.com'), { keyboardType: 'email-address' })}

          <Text style={styles.label}>{t('contacts.filters.birthday_month', 'Birthday in')}</Text>
          <View style={styles.chipRow}>
            <Pressable
              onPress={() => set('birthdayMonth', null)}
              style={[styles.chip, filters.birthdayMonth === null && styles.chipOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: filters.birthdayMonth === null }}
            >
              <Text style={[styles.chipText, filters.birthdayMonth === null && styles.chipTextOn]}>
                {t('contacts.filters.any_month', 'Any month')}
              </Text>
            </Pressable>
            {monthNames.map((name, i) => {
              const on = filters.birthdayMonth === i + 1;
              return (
                <Pressable
                  key={i}
                  onPress={() => set('birthdayMonth', on ? null : i + 1)}
                  style={[styles.chip, on && styles.chipOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{name}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={[styles.chipRow, styles.section]}>
            {triChip('hasEmail', t('contacts.filters.has_email', 'Has email'))}
            {triChip('hasPhone', t('contacts.filters.has_phone', 'Has phone'))}
            {triChip('hasPhoto', t('contacts.filters.has_photo', 'Has photo'))}
          </View>

          <Text style={[styles.label, styles.section]}>{t('contacts.filters.sort_by', 'Sort by')}</Text>
          <View style={styles.chipRow}>
            <Pressable
              onPress={() => updateSetting('sortContactsByLastName', false)}
              style={[styles.chip, !sortByLastName && styles.chipOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: !sortByLastName }}
            >
              <Text style={[styles.chipText, !sortByLastName && styles.chipTextOn]}>
                {t('contacts.filters.sort_first_name', 'First name')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => updateSetting('sortContactsByLastName', true)}
              style={[styles.chip, sortByLastName && styles.chipOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: sortByLastName }}
            >
              <Text style={[styles.chipText, sortByLastName && styles.chipTextOn]}>
                {t('contacts.filters.sort_last_name', 'Last name')}
              </Text>
            </Pressable>
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            onPress={() => onChange(EMPTY_CONTACT_FILTERS)}
            style={styles.footerBtn}
            accessibilityRole="button"
          >
            <Text style={styles.footerText}>{t('contacts.filters.clear', 'Clear')}</Text>
          </Pressable>
          <Pressable onPress={onClose} style={[styles.footerBtn, styles.footerPrimary]} accessibilityRole="button">
            <Text style={[styles.footerText, { color: c.primaryForeground }]}>
              {t('contacts.filters.close', 'Close')}
            </Text>
          </Pressable>
        </View>
      </Animated.View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: '85%',
      backgroundColor: c.popover,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderTopWidth: 1,
      borderColor: c.border,
      paddingTop: spacing.sm,
    },
    handleHit: { alignItems: 'center', paddingTop: spacing.xs, paddingBottom: spacing.sm },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.border },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { ...typography.bodySemibold, color: c.text },
    close: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.xs },
    body: { padding: spacing.lg, gap: spacing.sm },
    field: { gap: spacing.xs },
    section: { marginTop: spacing.sm },
    label: { ...typography.caption, color: c.textSecondary },
    input: {
      ...typography.body,
      color: c.text,
      height: componentSizes.inputHeight,
      paddingHorizontal: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.background,
    },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 2,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    chipOn: { backgroundColor: c.primary, borderColor: c.primary },
    chipOff: { borderColor: c.error },
    chipText: { ...typography.caption, color: c.text },
    chipTextOn: { color: c.primaryForeground },
    chipTextOff: { color: c.error, textDecorationLine: 'line-through' },
    footer: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    footerBtn: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      height: 40,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
    },
    footerPrimary: { backgroundColor: c.primary, borderColor: c.primary },
    footerText: { ...typography.bodySemibold, color: c.text },
  });
}
