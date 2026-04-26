import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput } from 'react-native';
import { Plus, Pencil, Trash2, Check, X, RotateCcw } from 'lucide-react-native';
import { SettingsSection } from './settings-section';
import { colors, spacing, radius, typography } from '../../theme/tokens';
import { useKeywordsStore, type KeywordDef } from '../../stores/keywords-store';

type Keyword = KeywordDef;

const PALETTE_KEYS = Object.keys(colors.tags) as (keyof typeof colors.tags)[];

export function KeywordSettings() {
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
          const palette = colors.tags[kw.color];
          return (
            <View key={kw.id} style={styles.kwRow}>
              <View style={[styles.kwDot, { backgroundColor: palette.dot }]} />
              <Text style={styles.kwLabel}>{kw.label}</Text>
              <Text style={styles.kwId}>$label:{kw.id}</Text>
              <View style={{ flexDirection: 'row', gap: 2 }}>
                <Pressable style={styles.iconBtn} onPress={() => setEditingId(kw.id)}>
                  <Pencil size={14} color={colors.mutedForeground} />
                </Pressable>
                <Pressable style={styles.iconBtn} onPress={() => deleteKeyword(kw.id)}>
                  <Trash2 size={14} color={colors.mutedForeground} />
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
              <Plus size={14} color={colors.mutedForeground} />
              <Text style={styles.outlineBtnText}>Add keyword</Text>
            </Pressable>
            <Pressable style={styles.outlineBtn} onPress={resetDefaults}>
              <RotateCcw size={14} color={colors.mutedForeground} />
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
  const [label, setLabel] = useState(initial?.label ?? '');
  const [color, setColor] = useState<keyof typeof colors.tags>(initial?.color ?? 'blue');

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
          placeholderTextColor={colors.mutedForeground}
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
            const p = colors.tags[key];
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
          <X size={14} color={colors.text} />
          <Text style={styles.cancelFormText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.saveBtn, !isValid && { opacity: 0.5 }]}
          onPress={handleSave}
          disabled={!isValid}
        >
          <Check size={14} color={colors.primaryForeground} />
          <Text style={styles.saveBtnText}>{initial ? 'Save' : 'Add'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  kwRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  kwDot: { width: 20, height: 20, borderRadius: 10 },
  kwLabel: { ...typography.bodyMedium, color: colors.text, flex: 1 },
  kwId: { fontSize: 10, color: colors.mutedForeground, fontFamily: 'monospace' },
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
    borderColor: colors.border,
  },
  outlineBtnText: { ...typography.caption, color: colors.mutedForeground },
  form: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    backgroundColor: colors.accent,
  },
  formLabel: { ...typography.caption, color: colors.mutedForeground, marginBottom: 4 },
  input: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    ...typography.body,
  },
  errorText: { ...typography.caption, color: colors.error, marginTop: 4 },
  palette: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  colorSwatch: { width: 24, height: 24, borderRadius: 12 },
  colorSwatchSelected: {
    borderWidth: 2,
    borderColor: colors.text,
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
    borderColor: colors.border,
  },
  cancelFormText: { ...typography.caption, color: colors.text },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  saveBtnText: { ...typography.caption, color: colors.primaryForeground, fontWeight: '500' },
});
