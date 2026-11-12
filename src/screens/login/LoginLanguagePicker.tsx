import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Check, Languages, X } from '../../components/icons';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { SUPPORTED_LOCALES, detectDeviceLocale, type LocaleCode } from '../../i18n';
import { radioOptionA11y } from '../../components/radio-a11y';

/** The name of `code` in its own language. */
export function localeLabel(code: LocaleCode): string {
  return SUPPORTED_LOCALES.find((l) => l.code === code)?.label ?? code;
}

/**
 * The language button in the sign-in screens' corner (webmail
 * components/auth/login-language-picker.tsx), for someone who can't read the
 * language the phone picked. The same list as Settings > Language; the
 * choice is the app's language setting, so it stays after the sign-in.
 */
export function LoginLanguagePicker() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const override = useLocaleStore((s) => s.override);
  const setOverride = useLocaleStore((s) => s.setOverride);
  const hydrated = useLocaleStore((s) => s.hydrated);
  const hydrate = useLocaleStore((s) => s.hydrate);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  const shown = localeLabel(locale);
  const choose = (code: LocaleCode | null) => {
    setOverride(code);
    setOpen(false);
  };
  const selected: LocaleCode | 'system' = override ?? 'system';
  const row = (code: LocaleCode | 'system', label: string) => {
    const active = selected === code;
    return (
      <Pressable
        key={code}
        {...radioOptionA11y(active)}
        onPress={() => choose(code === 'system' ? null : code)}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <Text style={styles.rowLabel}>{label}</Text>
        {active ? <Check size={16} color={c.primary} /> : null}
      </Pressable>
    );
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={8}
        style={styles.button}
        accessibilityRole="button"
        accessibilityLabel={t('login_a11y.language_button', 'Language: {language}', { language: shown })}
      >
        <Languages size={18} color={c.textSecondary} />
        <Text style={styles.buttonText} numberOfLines={1}>{shown}</Text>
      </Pressable>
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t('settings.appearance.language.label', 'Language')}</Text>
            <Pressable
              onPress={() => setOpen(false)}
              hitSlop={12}
              style={styles.close}
              accessibilityRole="button"
              accessibilityLabel={t('common.close', 'Close')}
            >
              <X size={22} color={c.textSecondary} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.list}>
            {row('system', `${t('settings.appearance.language.system_default', 'System default')} (${localeLabel(detectDeviceLocale())})`)}
            {SUPPORTED_LOCALES.map((l) => row(l.code, l.label))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    button: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      height: componentSizes.buttonLg,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.md,
      maxWidth: 180,
    },
    buttonText: { ...typography.caption, color: c.textSecondary },
    modal: { flex: 1, backgroundColor: c.background },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      height: componentSizes.headerHeight,
    },
    modalTitle: { ...typography.bodyMedium, color: c.text },
    close: { width: componentSizes.buttonLg, height: componentSizes.buttonLg, alignItems: 'center', justifyContent: 'center' },
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    rowPressed: { opacity: 0.6 },
    rowLabel: { ...typography.body, color: c.text },
  });
}
