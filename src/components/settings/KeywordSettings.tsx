import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, Alert, ActivityIndicator } from 'react-native';
import { Plus, Pencil, Trash2, Check, X, RotateCcw, ScanSearch, ChevronUp, ChevronDown } from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch, RadioGroup, Select } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useKeywordsStore, type KeywordDef } from '../../stores/keywords-store';
import { DARK_COLORS } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import {
  MAX_KEYWORD_ID_LENGTH,
  buildKeywordTree,
  composeKeywordId,
  descendantIds,
  effectiveParentId,
  keywordVisibility,
  moveKeyword,
  type KeywordNode,
  type KeywordVisibility,
} from '../../lib/keyword-nesting';
import { discoverKeywords } from '../../api/keyword-discovery';
import { findUnrecognizedKeywords, type UnrecognizedKeyword } from '../../lib/keyword-discovery';
import { jmapClient } from '../../api/jmap-client';

type Keyword = KeywordDef;

// Palette keys are theme-agnostic (same names in both palettes), so use DARK_COLORS
// at module load. The actual rendered swatch colors come from the active theme via `c.tags[key]`.
const PALETTE_KEYS = Object.keys(DARK_COLORS.tags) as (keyof typeof DARK_COLORS.tags)[];

// Indent per tree level in the tag list and the parent picker.
const NEST_INDENT = spacing.lg;

/** The tree as a list in display order, each node carrying its depth. */
function flattenTree(nodes: KeywordNode[]): KeywordNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

export function KeywordSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const keywords = useKeywordsStore((s) => s.keywords);
  const t = useLocaleStore((s) => s.t);
  const addKeyword = useKeywordsStore((s) => s.add);
  const updateKeyword = useKeywordsStore((s) => s.update);
  const removeKeyword = useKeywordsStore((s) => s.remove);
  const resetDefaults = useKeywordsStore((s) => s.resetDefaults);
  const moveKeywordInStore = useKeywordsStore((s) => s.move);
  const nestedTags = useSettingsStore((s) => s.nestedTags);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const hydrated = useKeywordsStore((s) => s.hydrated);
  const hydrate = useKeywordsStore((s) => s.hydrate);

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  // With nesting on, the list is the tree (children under their parent);
  // with it off, the stored order with no indentation.
  const rows: { def: Keyword; depth: number }[] = React.useMemo(
    () => (nestedTags
      ? flattenTree(buildKeywordTree(keywords)).map((node) => ({ def: node, depth: node.depth }))
      : keywords.map((def) => ({ def, depth: 0 }))),
    [keywords, nestedTags],
  );

  // The form leaves `id` as it was when editing, so a rename or re-parent
  // never strands the `$label:<id>` keyword already on mail.
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

  // One stray tap used to wipe a carefully built tag list (webmail removed
  // the button in 1.8.1); keep it behind a confirm.
  const confirmReset = () => {
    Alert.alert(
      t('settings.keywords.reset_defaults', 'Reset to Defaults'),
      t('settings.keywords.reset_confirm', 'Replace your tag list with the default tags? Tags already set on messages stay on the server.'),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        { text: t('settings.keywords.reset_defaults', 'Reset to Defaults'), style: 'destructive', onPress: resetDefaults },
      ],
    );
  };

  // Scan the mailbox for `$label:` keywords no local tag explains (#658) and
  // offer to add them with a proposed name and colour.
  const [scan, setScan] = useState<{
    phase: 'idle' | 'running' | 'done' | 'error';
    scanned: number;
    total: number;
    complete: boolean;
    found: UnrecognizedKeyword[];
    error?: string;
  }>({ phase: 'idle', scanned: 0, total: 0, complete: false, found: [] });
  const scanAbort = React.useRef({ aborted: false });
  const runScan = async () => {
    if (!jmapClient.isConnected) return;
    scanAbort.current = { aborted: false };
    setScan({ phase: 'running', scanned: 0, total: 0, complete: false, found: [] });
    try {
      const result = await discoverKeywords({
        signal: scanAbort.current,
        onProgress: (scanned, total) => setScan((s) => ({ ...s, scanned, total })),
      });
      const found = findUnrecognizedKeywords(result.keywords, useKeywordsStore.getState().keywords);
      setScan({ phase: 'done', scanned: result.scanned, total: result.total, complete: result.complete, found });
    } catch (err) {
      setScan((s) => ({ ...s, phase: 'error', error: err instanceof Error ? err.message : String(err) }));
    }
  };
  useEffect(() => () => { scanAbort.current.aborted = true; }, []);
  const adoptFound = (kw: UnrecognizedKeyword) => {
    addKeyword({ id: kw.id, label: kw.label, color: kw.color });
    setScan((s) => ({ ...s, found: s.found.filter((f) => f.id !== kw.id) }));
  };

  return (
    <SettingsSection title={t('settings.keywords.title', "Email Tags")} description={t('settings.keywords.description_mobile', "Colored tags to organize your mail.")}>
      <SettingItem
        label={t('settings.keywords.nesting.label', 'Nested Tags')}
        description={t('settings.keywords.nesting.description', 'Nest tags underneath other tags and show them as a tree in the sidebar.')}
      >
        <ToggleSwitch checked={nestedTags} onChange={(v) => updateSetting('nestedTags', v)} />
      </SettingItem>
      <View style={{ gap: spacing.sm }}>
        {rows.map(({ def: kw, depth }) => {
          if (editingId === kw.id) {
            return (
              <KeywordForm
                key={kw.id}
                initial={kw}
                keywords={keywords}
                nestedTags={nestedTags}
                onSave={(k) => saveKeyword(k, true)}
                onCancel={() => setEditingId(null)}
              />
            );
          }
          const palette = c.tags[kw.color];
          const canMoveUp = moveKeyword(keywords, kw.id, 'up', nestedTags) !== keywords;
          const canMoveDown = moveKeyword(keywords, kw.id, 'down', nestedTags) !== keywords;
          return (
            <View key={kw.id} style={[styles.kwRow, depth > 0 && { marginStart: depth * NEST_INDENT }]}>
              <View style={[styles.kwDot, { backgroundColor: palette.dot }]} />
              <Text style={styles.kwLabel}>{kw.label}</Text>
              <Text style={styles.kwId}>$label:{kw.id}</Text>
              <View style={{ flexDirection: 'row', gap: 2 }}>
                <Pressable
                  style={[styles.iconBtn, !canMoveUp && styles.iconBtnDisabled]}
                  onPress={() => moveKeywordInStore(kw.id, 'up')}
                  disabled={!canMoveUp}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canMoveUp }}
                  accessibilityLabel={t('settings.appearance.message_list_order.move_up', 'Move up')}
                >
                  <ChevronUp size={14} color={c.mutedForeground} />
                </Pressable>
                <Pressable
                  style={[styles.iconBtn, !canMoveDown && styles.iconBtnDisabled]}
                  onPress={() => moveKeywordInStore(kw.id, 'down')}
                  disabled={!canMoveDown}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !canMoveDown }}
                  accessibilityLabel={t('settings.appearance.message_list_order.move_down', 'Move down')}
                >
                  <ChevronDown size={14} color={c.mutedForeground} />
                </Pressable>
                <Pressable style={styles.iconBtn} onPress={() => setEditingId(kw.id)} accessibilityRole="button" accessibilityLabel={t('settings.keywords.edit', "Edit tag")}>
                  <Pencil size={14} color={c.mutedForeground} />
                </Pressable>
                <Pressable style={styles.iconBtn} onPress={() => deleteKeyword(kw.id)} accessibilityRole="button" accessibilityLabel={t('settings.keywords.delete', "Delete tag")}>
                  <Trash2 size={14} color={c.mutedForeground} />
                </Pressable>
              </View>
            </View>
          );
        })}

        {isAdding && (
          <KeywordForm
            keywords={keywords}
            nestedTags={nestedTags}
            onSave={(k) => saveKeyword(k, false)}
            onCancel={() => setIsAdding(false)}
          />
        )}

        {!isAdding && editingId === null && (
          <View style={styles.bottomActions}>
            <Pressable style={styles.outlineBtn} onPress={() => setIsAdding(true)}>
              <Plus size={14} color={c.mutedForeground} />
              <Text style={styles.outlineBtnText}>{t('settings.keywords.add_keyword', "Add Tag")}</Text>
            </Pressable>
            <Pressable style={styles.outlineBtn} onPress={confirmReset}>
              <RotateCcw size={14} color={c.mutedForeground} />
              <Text style={styles.outlineBtnText}>{t('settings.keywords.reset_defaults', "Reset to Defaults")}</Text>
            </Pressable>
            <Pressable style={styles.outlineBtn} onPress={() => { void runScan(); }} disabled={scan.phase === 'running'}>
              {scan.phase === 'running' ? (
                <ActivityIndicator size="small" color={c.mutedForeground} />
              ) : (
                <ScanSearch size={14} color={c.mutedForeground} />
              )}
              <Text style={styles.outlineBtnText}>{t('settings.keywords.discover.scan', 'Find tags in mailbox')}</Text>
            </Pressable>
          </View>
        )}

        {scan.phase === 'running' && (
          <Text style={styles.scanStatus}>
            {t('settings.keywords.discover.progress', `Scanned ${scan.scanned} of ${scan.total} messages…`, { scanned: scan.scanned, total: scan.total })}
          </Text>
        )}
        {scan.phase === 'error' && (
          <Text style={[styles.scanStatus, { color: c.error }]}>{scan.error}</Text>
        )}
        {scan.phase === 'done' && (
          <View style={styles.scanResults}>
            <Text style={styles.scanStatus}>
              {scan.found.length === 0
                ? t('settings.keywords.discover.none', `No unknown tags found in ${scan.scanned} messages.`, { scanned: scan.scanned })
                : t('settings.keywords.discover.found', `${scan.found.length} tags found that are not defined here.`, { count: scan.found.length })}
              {!scan.complete ? ` ${t('settings.keywords.discover.partial', '(The scan stopped at the newest messages only.)')}` : ''}
            </Text>
            {scan.found.map((kw) => (
              <View key={kw.id} style={styles.kwRow}>
                <View style={[styles.kwDot, { backgroundColor: c.tags[kw.color]?.dot ?? c.textMuted }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.kwLabel}>{kw.label}</Text>
                  <Text style={styles.kwId}>{kw.keyword} · {kw.count}</Text>
                </View>
                <Pressable style={styles.outlineBtn} onPress={() => adoptFound(kw)}>
                  <Plus size={14} color={c.mutedForeground} />
                  <Text style={styles.outlineBtnText}>{t('common.add', 'Add')}</Text>
                </Pressable>
              </View>
            ))}
            {scan.found.length > 1 && (
              <Pressable style={styles.outlineBtn} onPress={() => { for (const kw of [...scan.found]) adoptFound(kw); }}>
                <Plus size={14} color={c.mutedForeground} />
                <Text style={styles.outlineBtnText}>{t('settings.keywords.discover.add_all', 'Add all')}</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    </SettingsSection>
  );
}

interface KeywordFormProps {
  initial?: Keyword;
  /** Every defined tag, for the duplicate check and the parent picker. */
  keywords: Keyword[];
  nestedTags: boolean;
  onSave: (kw: Keyword) => void;
  onCancel: () => void;
}

function KeywordForm({ initial, keywords, nestedTags, onSave, onCancel }: KeywordFormProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [label, setLabel] = useState(initial?.label ?? '');
  const [color, setColor] = useState<keyof typeof DARK_COLORS.tags>(initial?.color ?? 'blue');
  const [visibility, setVisibility] = useState<KeywordVisibility>(initial ? keywordVisibility(initial) : 'show');
  // The parent the tag had when the form opened, to tell whether it changed.
  const [initialParent] = useState(() => (initial ? effectiveParentId(initial, new Set(keywords.map((k) => k.id))) : null));
  // '' stands for "No parent" in the picker.
  const [parent, setParent] = useState<string>(initialParent ?? '');

  // Editing never changes the id; a new tag's id is composed under its parent.
  const id = initial ? initial.id : composeKeywordId(nestedTags ? parent || null : null, label);
  const isDuplicate = !initial && id.length > 0 && keywords.some((k) => k.id === id);
  const isTooLong = !initial && id.length > MAX_KEYWORD_ID_LENGTH;
  const isValid = id.length > 0 && label.trim().length > 0 && !isDuplicate && !isTooLong;

  // Any tag can be the parent except this one and the tags below it, which
  // would cut the branch off the tree.
  const parentOptions = React.useMemo(() => {
    if (!nestedTags) return [];
    const excluded = initial ? descendantIds(keywords, initial.id) : new Set<string>();
    if (initial) excluded.add(initial.id);
    return [
      { value: '', label: t('settings.keywords.no_parent', 'No parent') },
      ...flattenTree(buildKeywordTree(keywords))
        .filter((node) => !excluded.has(node.id))
        .map((node) => ({ value: node.id, label: `${'\u00A0\u00A0\u00A0'.repeat(node.depth)}${node.label}` })),
    ];
  }, [initial, keywords, nestedTags, t]);

  const handleSave = () => {
    if (!isValid) return;
    const kw: Keyword = { id, label: label.trim(), color, visibility };
    const chosenParent = parent || null;
    if (initial) {
      // Only a changed parent is written; "No parent" is an explicit null so
      // a slash id stays at the top level.
      if (nestedTags && chosenParent !== initialParent) kw.parentId = chosenParent;
    } else if (nestedTags && chosenParent) {
      kw.parentId = chosenParent;
    }
    onSave(kw);
  };

  return (
    <View style={styles.form}>
      <View>
        <Text style={styles.formLabel}>{t('settings.keywords.label_field', "Display Name")}</Text>
        <TextInput
          value={label}
          onChangeText={setLabel}
          placeholder={t('settings.keywords.label_placeholder', "e.g. Work, Personal, Urgent")}
          placeholderTextColor={c.mutedForeground}
          style={styles.input}
          maxLength={30}
          autoFocus
        />
        {nestedTags && !initial && id.length > 0 && <Text style={styles.kwId}>$label:{id}</Text>}
        {isDuplicate && <Text style={styles.errorText}>{t('settings.keywords.id_exists', "This tag ID already exists")}</Text>}
        {isTooLong && (
          <Text style={styles.errorText}>
            {t('settings.keywords.too_long', `This tag path is too long (at most ${MAX_KEYWORD_ID_LENGTH} characters)`, { max: MAX_KEYWORD_ID_LENGTH })}
          </Text>
        )}
      </View>

      {nestedTags && (
        <View>
          <Text style={styles.formLabel}>{t('settings.keywords.parent_field', 'Parent Tag')}</Text>
          <Select
            value={parent}
            onChange={setParent}
            options={parentOptions}
            accessibilityLabel={t('settings.keywords.parent_field', 'Parent Tag')}
          />
        </View>
      )}

      <View>
        <Text style={styles.formLabel}>{t('settings.keywords.visibility_field', 'Sidebar visibility')}</Text>
        <RadioGroup
          value={visibility}
          onChange={(v) => setVisibility(v as KeywordVisibility)}
          options={[
            { value: 'show', label: t('settings.keywords.visibility.show', 'Show') },
            { value: 'unread', label: t('settings.keywords.visibility.unread', 'Show if unread') },
            { value: 'hide', label: t('settings.keywords.visibility.hide', 'Hide') },
          ]}
        />
      </View>

      <View>
        <Text style={styles.formLabel}>{t('settings.keywords.color_field', "Color")}</Text>
        <View style={styles.palette}>
          {PALETTE_KEYS.map((key) => {
            const p = c.tags[key];
            return (
              <Pressable
                key={key}
                onPress={() => setColor(key)}
                accessibilityRole="radio"
                accessibilityState={{ selected: color === key }}
                accessibilityLabel={key}
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
          <Text style={styles.cancelFormText}>{t('common.cancel', "Cancel")}</Text>
        </Pressable>
        <Pressable
          style={[styles.saveBtn, !isValid && { opacity: 0.5 }]}
          onPress={handleSave}
          disabled={!isValid}
        >
          <Check size={14} color={c.primaryForeground} />
          <Text style={styles.saveBtnText}>{initial ? t('common.save', "Save") : t('common.add', "Add")}</Text>
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
  iconBtnDisabled: { opacity: 0.35 },
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
  scanStatus: { ...typography.caption, color: c.mutedForeground, paddingTop: spacing.xs },
  scanResults: { gap: spacing.sm },
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
