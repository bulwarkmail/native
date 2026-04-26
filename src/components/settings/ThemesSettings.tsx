import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Upload, Check, Palette, Trash2 } from 'lucide-react-native';
import { SettingsSection, SettingItem } from './settings-section';
import Button from '../Button';
import { colors, spacing, radius, typography } from '../../theme/tokens';

interface Theme {
  id: string | null;
  name: string;
  author: string;
  builtIn?: boolean;
  variants?: ('light' | 'dark')[];
}

const BUILT_IN: Theme[] = [
  { id: null,    name: 'Default',  author: 'Bulwark', builtIn: true, variants: ['light', 'dark'] },
  { id: 'qui',   name: 'Qui',      author: 'Bulwark', builtIn: true, variants: ['dark'] },
  { id: 'sepia', name: 'Sepia',    author: 'Bulwark', builtIn: true, variants: ['light'] },
];

export function ThemesSettings() {
  const [themes] = useState<Theme[]>(BUILT_IN);
  const [active, setActive] = useState<string | null>(null);

  return (
    <SettingsSection
      title="Themes"
      description="Customize the appearance with color themes."
      experimental
      experimentalDescription="Themes is an experimental feature. Custom themes may not cover all UI elements, and theme formats could change in future updates."
    >
      <View style={styles.grid}>
        {themes.map((theme) => {
          const isActive = active === theme.id;
          return (
            <Pressable
              key={theme.id ?? 'default'}
              onPress={() => setActive(theme.id)}
              style={[styles.card, isActive && styles.cardActive]}
            >
              <View style={styles.preview}>
                <Palette size={32} color={colors.mutedForeground} style={{ opacity: 0.4 }} />
              </View>
              <View style={{ width: '100%' }}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardName} numberOfLines={1}>{theme.name}</Text>
                  {isActive && <Check size={16} color={colors.primary} />}
                </View>
                <Text style={styles.cardAuthor} numberOfLines={1}>{theme.author}</Text>
                {theme.variants && (
                  <View style={styles.variants}>
                    {theme.variants.map((v) => (
                      <View key={v} style={styles.variantPill}>
                        <Text style={styles.variantText}>{v}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            </Pressable>
          );
        })}
      </View>

      <SettingItem
        label="Upload Theme"
        description="Install a custom theme from a .zip file."
      >
        <Button variant="outline" size="sm" icon={<Upload size={14} color={colors.text} />}>
          Upload .zip
        </Button>
      </SettingItem>
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
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
    borderColor: colors.border,
    backgroundColor: colors.card,
    gap: spacing.sm,
  },
  cardActive: {
    borderColor: colors.primary,
    backgroundColor: 'rgba(59, 130, 246, 0.05)',
  },
  preview: {
    width: '100%',
    aspectRatio: 16 / 10,
    borderRadius: radius.md,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardName: { ...typography.bodyMedium, color: colors.text, flex: 1 },
  cardAuthor: { ...typography.caption, color: colors.mutedForeground },
  variants: { flexDirection: 'row', gap: 4, marginTop: 4 },
  variantPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.xs,
    backgroundColor: colors.muted,
  },
  variantText: { fontSize: 10, color: colors.mutedForeground },
});
