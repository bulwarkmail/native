import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput } from 'react-native';
import { Plus, Pencil, Trash2, Check, X, RotateCcw } from 'lucide-react-native';
import { SettingsSection } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useKeywordsStore, type KeywordDef } from '../../stores/keywords-store';
import { DARK_COLORS } from '../../theme/tokens';

type Keyword = KeywordDef;

// Palette keys are theme-agnostic (same names in both palettes), so use DARK_COLORS
// at module load. The actual rendered swatch colors come from the active theme via `c.tags[key]`.
const PALETTE_KEYS = Object.keys(DARK_COLORS.tags) as (keyof typeof DARK_COLORS.tags)[];

export function KeywordSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const keywords = useKeywordsStore((s) => s.keywords);
  const addKeyword = useKeywordsStore((s) => s.add);
  const updateKeyword = useKeywordsStore((s) => s.update);
  const removeKeyword = useKeywordsStore((s) => s.remove);
  const resetDefaults = useKeywordsStore((s) => s.resetDefaults);
  const hydrated = useKeywordsStore((s) => s.hydrated);
  const hydrate = useKeywordsStore((s) => s.hydrate);

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const saveKeyword = (kw: Keyword, editing: boolean) => {
    if (editing && editingId) {
      const { id, ...patch } = kw;
      updateKeyword(editingId, patch);
      setEditingId(null);
    } else {
      addKeyword(kw);
      setIsAdding(false);
    }
  };

  const deleteKeyword = (id: string) => {
    removeKeyword(id);
  };

  return (
    <SettingsSection title="Keywords & Labels" description="Colored tags to organize your mail.">
      <View style={{ gap: spacing.sm }}>
        {keywords.map((kw) => {
          if (editingId === kw.id) {
            return (
              <KeywordForm
                key={kw.id}
                initial={kw}
                existingIds={keywords.filter((k) => k.id !== kw.id).map((k) => k.id)}
                onSave={(k) => saveKeyword(k, true)}
                onCancel={() => setEditingId(null)}
              />
            );
          }
          const palette = c.tags[kw.color];
          return (
            <View key={kw.id} style={styles.kwRow}>
              <View style={[styles.kwDot, { backgroundColor: palette.dot }]} />
              <Text style={styles.kwLabel}>{kw.label}</Text>
              <Text style={styles.kwId}>$label:{kw.id}</Text>
              <View style={{ flexDirection: 'row', gap: 2 }}>
                <Pressable style={styles.iconBtn} onPress={() => setEditingId(kw.id)}>
                  <Pencil size={14} color={c.mutedForeground} />
                </Pressable>
                <Pressable style={styles.iconBtn} onPress={() => deleteKeyword(kw.id)}>
                  <Trash2 size={14} color={c.mutedForeground} />
                </Pressable>
              </View>
            </View>
          );
        })}

        {isAdding && (
          <KeywordForm
            existingIds={keywords.map((k) => k.id)}
            onSave={(k) => saveKeyword(k, false)}
            onCancel={() => setIsAdding(false)}
          />
        )}

        {!isAdding && editingId === null && (
          <View style={styles.bottomActions}>
            <Pressable style={styles.outlineBtn} onPress={() => setIsAdding(true)}>
              <Plus size={14} color={c.mutedForeground} />
              <Text style={styles.outlineBtnText}>Add keyword</Text>
            </Pressable>
            <Pressable style={styles.outlineBtn} onPress={resetDefaults}>
              <RotateCcw size={14} color={c.mutedForeground} />
              <Text style={styles.outlineBtnText}>Reset defaults</Text>
            </Pressable>
          </View>
        )}
      </View>
    </SettingsSection>
  );
}

interface KeywordFormProps {
  initial?: Keyword;
  existingIds: string[];
  onSave: (kw: Keyword) => void;
  onCancel: () => void;
}

function KeywordForm({ initial, existingIds, onSave, onCancel }: KeywordFormProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [label, setLabel] = useState(initial?.label ?? '');
  const [color, setColor] = useState<keyof typeof DARK_COLORS.tags>(initial?.color ?? 'blue');

  const normalizedId = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const isDuplicate = normalizedId.length > 0 && existingIds.includes(normalizedId);
  const isValid = normalizedId.length > 0 && label.trim().length > 0 && !isDuplicate;

  const handleSave = () => {
    if (!isValid) return;
    onSave({ id: normalizedId, label: label.trim(), color });
  };

  return (
    <View style={styles.form}>
      <View>
        <Text style={styles.formLabel}>Label</Text>
        <TextInput
          value={label}
          onChangeText={setLabel}
          placeholder="e.g. Important"
          placeholderTextColor={c.mutedForeground}
          style={styles.input}
          maxLength={30}
          autoFocus
        />
        {isDuplicate && <Text style={styles.errorText}>An ID with that name already exists.</Text>}
      </View>

      <View>
        <Text style={styles.formLabel}>Color</Text>
        <View style={styles.palette}>
          {PALETTE_KEYS.map((key) => {
            const p = c.tags[key];
            return (
              <Pressable
                key={key}
                onPress={() => setColor(key)}
                style={[
                  styles.colorSwatch,
                  { backgroundColor: p.dot },
                  color === key && styles.colorSwatchSelected,
                ]}
              />
            );
          })}
        </View>
      </View>

      <View style={styles.formActions}>
        <Pressable style={styles.cancelFormBtn} onPress={onCancel}>
          <X size={14} color={c.text} />
          <Text style={styles.cancelFormText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.saveBtn, !isValid && { opacity: 0.5 }]}
          onPress={handleSave}
          disabled={!isValid}
        >
          <Check size={14} color={c.primaryForeground} />
          <Text style={styles.saveBtnText}>{initial ? 'Save' : 'Add'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  kwRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.background,
  },
  kwDot: { width: 20, height: 20, borderRadius: 10 },
  kwLabel: { ...typography.bodyMedium, color: c.text, flex: 1 },
  kwId: { fontSize: 10, color: c.mutedForeground, fontFamily: 'monospace' },
  iconBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  bottomActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  outlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: c.border,
  },
  outlineBtnText: { ...typography.caption, color: c.mutedForeground },
  form: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.primaryBorder,
    backgroundColor: c.accent,
  },
  formLabel: { ...typography.caption, color: c.mutedForeground, marginBottom: 4 },
  input: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
    color: c.text,
    ...typography.body,
  },
  errorText: { ...typography.caption, color: c.error, marginTop: 4 },
  palette: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  colorSwatch: { width: 24, height: 24, borderRadius: 12 },
  colorSwatchSelected: {
    borderWidth: 2,
    borderColor: c.text,
  },
  formActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  cancelFormBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
  },
  cancelFormText: { ...typography.caption, color: c.text },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: c.primary,
  },
  saveBtnText: { ...typography.caption, color: c.primaryForeground, fontWeight: '500' },
});
}
