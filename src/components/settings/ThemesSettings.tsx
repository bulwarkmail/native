import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Check } from '../icons';
import { SettingsSection } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { resolvePalette, useColors, useResolvedTheme } from '../../theme/colors';
import { BUILTIN_THEMES } from '../../theme/builtin-themes';
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { usePolicyStore, useSettingLocked } from '../../stores/policy-store';
import { visibleThemeCards } from './theme-cards';

interface ThemeCard {
  id: string | null;
  name: string;
  description: string;
}

/**
 * Built-in colour themes ported from the webmail (lib/builtin-themes.ts).
 * Custom zip themes and the marketplace stay webmail-only: the native app has
 * no CSS pipeline, only the token subset each theme overrides.
 */
export function ThemesSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const scheme = useResolvedTheme();
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const active = useSettingsStore((s) => s.activeThemeId);
  const update = useSettingsStore((s) => s.updateSetting);
  // The organisation can turn built-in themes off, and pin one (or the
  // default, with themes turned off) for everyone (webmail themes-settings.tsx).
  const policy = usePolicyStore((s) => s.effective);
  const themeLocked = useSettingLocked('activeThemeId');

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const cards = React.useMemo<ThemeCard[]>(() => visibleThemeCards([
    {
      id: null,
      name: t('settings.themes.default_name', 'Bulwark'),
      description: t('settings.themes.default_description', 'The default light and dark palettes.'),
    },
    ...BUILTIN_THEMES.map((theme) => ({ id: theme.id, name: theme.name, description: theme.description })),
  ], policy), [t, policy]);

  return (
    <SettingsSection
      title={t('settings.themes.title', 'Themes')}
      description={t(
        'settings.themes.mobile_description',
        'Pick a colour theme. Themes follow the light/dark setting from Appearance; custom theme packages are managed in the webmail.',
      )}
    >
      {themeLocked && (
        <View style={styles.lockedNote}>
          <Text style={styles.lockedNoteText}>{t('settings.themes.locked', 'Theme selection is locked by an administrator.')}</Text>
        </View>
      )}
      <View style={styles.grid}>
        {cards.map((card) => {
          const isActive = (active ?? null) === card.id;
          const preview = resolvePalette(scheme, card.id);
          return (
            <Pressable
              key={card.id ?? 'default'}
              onPress={() => update('activeThemeId', card.id)}
              disabled={themeLocked}
              accessibilityRole="radio"
              accessibilityState={{ selected: isActive, checked: isActive, disabled: themeLocked }}
              accessibilityLabel={card.name}
              style={[styles.card, isActive && styles.cardActive, themeLocked && !isActive && styles.cardDisabled]}
            >
              <View style={[styles.preview, { backgroundColor: preview.background, borderColor: preview.border }]}>
                <View style={[styles.previewRail, { backgroundColor: preview.surface, borderRightColor: preview.border }]} />
                <View style={styles.previewBody}>
                  <View style={[styles.previewBar, { backgroundColor: preview.primary, width: '55%' }]} />
                  <View style={[styles.previewBar, { backgroundColor: preview.text, width: '80%', opacity: 0.8 }]} />
                  <View style={[styles.previewBar, { backgroundColor: preview.mutedForeground, width: '65%', opacity: 0.6 }]} />
                  <View style={styles.previewDots}>
                    {[preview.success, preview.warning, preview.error, preview.info].map((color, i) => (
                      <View key={i} style={[styles.previewDot, { backgroundColor: color }]} />
                    ))}
                  </View>
                </View>
              </View>
              <View style={{ width: '100%' }}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardName} numberOfLines={1}>{card.name}</Text>
                  {isActive && <Check size={16} color={c.primary} />}
                </View>
                <Text style={styles.cardDescription} numberOfLines={2}>{card.description}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  card: {
    width: '47%',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: c.border,
    backgroundColor: c.card,
    gap: spacing.sm,
  },
  cardActive: {
    borderColor: c.primary,
    backgroundColor: c.primaryBg,
  },
  cardDisabled: { opacity: 0.6 },
  lockedNote: {
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.warning,
    backgroundColor: c.warningBg,
  },
  lockedNoteText: { ...typography.caption, color: c.text },
  preview: {
    width: '100%',
    aspectRatio: 16 / 10,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  previewRail: { width: '22%', borderRightWidth: 1 },
  previewBody: { flex: 1, padding: spacing.sm, gap: 6, justifyContent: 'center' },
  previewBar: { height: 6, borderRadius: 3 },
  previewDots: { flexDirection: 'row', gap: 4, marginTop: 2 },
  previewDot: { width: 8, height: 8, borderRadius: 4 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardName: { ...typography.bodyMedium, color: c.text, flex: 1 },
  cardDescription: { ...typography.caption, color: c.mutedForeground, marginTop: 2 },
});
}
