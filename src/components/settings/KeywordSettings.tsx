import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput, Alert, ActivityIndicator } from 'react-native';
import { Plus, Pencil, Trash2, Check, X, RotateCcw, ScanSearch } from '../icons';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useKeywordsStore, currentTagsLogin, type KeywordDef, type KeywordVisibility } from '../../stores/keywords-store';
import { useEmailStore } from '../../stores/email-store';
import { supportsBulwarkMetadata } from '../../api/bulwark-metadata';
import { DARK_COLORS } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { discoverKeywords } from '../../api/keyword-discovery';
import { findUnrecognizedKeywords, type UnrecognizedKeyword } from '../../lib/keyword-discovery';
import { jmapClient } from '../../api/jmap-client';
import { deleteKeywordWithUndo } from '../../lib/settings-undo';
import { composeKeywordId, MAX_KEYWORD_ID_LENGTH } from '../../lib/new-tag';
import {
  formatKeyword, getKeywordVisibility, getParentKeywordId, hasChildKeywords, parentKeywordOptions,
} from '../../lib/keyword-nesting';

type Keyword = KeywordDef;

// Palette keys are theme-agnostic (same names in both palettes), so use DARK_COLORS
// at module load. The actual rendered swatch colors come from the active theme via `c.tags[key]`.
const PALETTE_KEYS = Object.keys(DARK_COLORS.tags) as (keyof typeof DARK_COLORS.tags)[];

export function KeywordSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const keywords = useKeywordsStore((s) => s.keywords);
  const t = useLocaleStore((s) => s.t);
  const addKeyword = useKeywordsStore((s) => s.add);
  const updateKeyword = useKeywordsStore((s) => s.update);
  const resetDefaults = useKeywordsStore((s) => s.resetDefaults);
  const hydrated = useKeywordsStore((s) => s.hydrated);
  const hydrate = useKeywordsStore((s) => s.hydrate);
  const nested = useKeywordsStore((s) => s.nested);
  const setNested = useKeywordsStore((s) => s.setNested);

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const saveKeyword = (kw: Keyword, editing: boolean) => {
    if (editing && editingId) {
      // The id stays: it is on the messages, and this app does not move
      // them to a new keyword (webmail migrateKeyword).
      updateKeyword(editingId, { label: kw.label, color: kw.color });
      setEditingId(null);
    } else {
      addKeyword(kw);
      setIsAdding(false);
    }
  };

  // A tag can be put back as it was, so it goes at once with an Undo
  // (webmail R3).
  const deleteKeyword = (id: string) => {
    deleteKeywordWithUndo(id, t);
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

  // Sidebar visibility (webmail keyword-settings.tsx).
  const visibilityOptions = [
    { value: 'show', label: t('settings.keywords.visibility.show', 'Show') },
    { value: 'unread', label: t('settings.keywords.visibility.unread', 'Show if unread') },
    { value: 'hide', label: t('settings.keywords.visibility.hide', 'Hide') },
  ];

  return (
    <SettingsSection title={t('settings.keywords.title', "Email Tags")} description={t('settings.keywords.description_mobile', "Colored tags to organize your mail.")}>
      <SettingItem
        label={t('settings.keywords.nesting.label', 'Nested tags')}
        description={t('settings.keywords.nesting.description', 'Nest tags underneath other tags and show them as a tree in the sidebar.')}
      >
        <ToggleSwitch
          checked={nested}
          onChange={setNested}
          accessibilityLabel={t('settings.keywords.nesting.label', 'Nested tags')}
        />
      </SettingItem>
      <View style={{ gap: spacing.sm }}>
        {keywords.map((kw) => {
          if (editingId === kw.id) {
            return (
              <KeywordForm
                key={kw.id}
                initial={kw}
                existingIds={keywords.filter((k) => k.id !== kw.id).map((k) => k.id)}
                keywords={keywords}
                nested={nested}
                onSave={(k) => saveKeyword(k, true)}
                onCancel={() => setEditingId(null)}
              />
            );
          }
          const palette = (c.tagsAsPicked ?? c.tags)[kw.color];
          // A tag with tags nested under it can't go first (webmail
          // has_children_delete): its children would lose their parent.
          const hasChildren = hasChildKeywords(kw.id, keywords);
          return (
            <View key={kw.id} style={styles.kwCard}>
              <View style={styles.kwCardTop}>
                <View style={[styles.kwDot, { backgroundColor: palette.dot }]} />
                <Text style={styles.kwLabel}>{formatKeyword(kw.id, keywords, nested)}</Text>
                <View style={{ flexDirection: 'row', gap: 2 }}>
                  <Pressable style={styles.iconBtn} onPress={() => setEditingId(kw.id)} accessibilityRole="button" accessibilityLabel={t('settings.keywords.edit_tag', 'Edit {name}', { name: kw.label })}>
                    <Pencil size={14} color={c.mutedForeground} />
                  </Pressable>
                  <Pressable
                    style={[styles.iconBtn, hasChildren && { opacity: 0.4 }]}
                    onPress={() => deleteKeyword(kw.id)}
                    disabled={hasChildren}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: hasChildren }}
                    accessibilityLabel={t('settings.keywords.delete_tag', 'Delete {name}', { name: kw.label })}
                    accessibilityHint={hasChildren ? t('settings.keywords.has_children_delete', 'Remove the tags nested under this one first') : undefined}
                  >
                    <Trash2 size={14} color={c.mutedForeground} />
                  </Pressable>
                </View>
              </View>
              <View style={styles.kwCardBottom}>
                <Text style={[styles.kwId, { flex: 1 }]} numberOfLines={1}>$label:{kw.id}</Text>
                <Text style={styles.kwVisibilityLabel}>{t('settings.keywords.visibility_field', 'Sidebar visibility')}</Text>
                <Select
                  value={getKeywordVisibility(kw)}
                  onChange={(value) => updateKeyword(kw.id, { visibility: value as KeywordVisibility })}
                  options={visibilityOptions}
                />
              </View>
            </View>
          );
        })}

        {isAdding && (
          <KeywordForm
            existingIds={keywords.map((k) => k.id)}
            keywords={keywords}
            nested={nested}
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
                <View style={[styles.kwDot, { backgroundColor: (c.tagsAsPicked ?? c.tags)[kw.color]?.dot ?? c.textMuted }]} />
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
      <SharedTagsSection />
    </SettingsSection>
  );
}

/**
 * The shared tags of each group mailbox in the sidebar (#1310): what every
 * member sees on its mail, read from the group's Inbox metadata. Shown, not
 * edited here; Bulwark on the web edits them.
 */
function SharedTagsSection() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const sharedTags = useKeywordsStore((s) => s.sharedTags);
  const loadSharedTags = useKeywordsStore((s) => s.loadSharedTags);
  const accounts = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of mailboxes) {
      if (m.isShared && m.accountId && !seen.has(m.accountId)) seen.set(m.accountId, m.accountName ?? m.accountId);
    }
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [mailboxes]);
  useEffect(() => {
    for (const account of accounts) void loadSharedTags(account.id);
  }, [accounts, loadSharedTags]);

  if (accounts.length === 0) return null;
  const login = currentTagsLogin();
  return (
    <View style={styles.sharedBlock}>
      <Text style={styles.sharedTitle}>{t('shared_tags.title', 'Shared tags')}</Text>
      <Text style={styles.scanStatus}>
        {t('shared_tags.description', 'Tags of your group mailboxes. Everyone in the group sees the same names and colors on its mail.')}
      </Text>
      {accounts.map((account) => {
        const entry = sharedTags[account.id];
        const tags = entry && entry.login === login ? entry.tags : null;
        return (
          <View key={account.id} style={styles.sharedAccount}>
            <Text style={styles.sharedAccountName}>{account.name}</Text>
            {tags === null ? (
              <Text style={styles.scanStatus}>
                {supportsBulwarkMetadata(account.id)
                  ? t('shared_tags.loading', 'Loading…')
                  : t('shared_tags.unsupported', "This mail server can't keep shared tags, so this mailbox shows your own tags.")}
              </Text>
            ) : tags.length === 0 ? (
              <Text style={styles.scanStatus}>{t('shared_tags.empty', 'No shared tags yet.')}</Text>
            ) : (
              tags.map((kw) => (
                <View key={kw.id} style={styles.kwRow}>
                  <View style={[styles.kwDot, { backgroundColor: (c.tagsAsPicked ?? c.tags)[kw.color]?.dot ?? c.textMuted }]} />
                  <Text style={styles.kwLabel}>{kw.label}</Text>
                  <Text style={styles.kwId}>$label:{kw.id}</Text>
                </View>
              ))
            )}
          </View>
        );
      })}
    </View>
  );
}

interface KeywordFormProps {
  initial?: Keyword;
  existingIds: string[];
  /** Every tag, for the parent picker. */
  keywords: Keyword[];
  /** "Nested tags" is on: a new tag can go under another one. */
  nested: boolean;
  onSave: (kw: Keyword) => void;
  onCancel: () => void;
}

function KeywordForm({ initial, existingIds, keywords, nested, onSave, onCancel }: KeywordFormProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [label, setLabel] = useState(initial?.label ?? '');
  const [color, setColor] = useState<keyof typeof DARK_COLORS.tags>(initial?.color ?? 'blue');
  const [parentId, setParentId] = useState('');

  // A new tag takes the id of its name under its parent (webmail
  // KeywordEditForm). An edited tag keeps its id, which is on the messages.
  const normalizedId = initial ? initial.id : composeKeywordId(parentId || null, label);
  const isDuplicate = !initial && normalizedId.length > 0 && existingIds.includes(normalizedId);
  const isTooLong = !initial && normalizedId.length > MAX_KEYWORD_ID_LENGTH;
  const isValid = normalizedId.length > 0 && label.trim().length > 0 && !isDuplicate && !isTooLong;
  const parentOptions = [
    { value: '', label: t('settings.keywords.no_parent', 'No parent') },
    ...parentKeywordOptions(keywords).map((o) => ({ value: o.id, label: o.label })),
  ];
  const initialParent = initial ? getParentKeywordId(initial.id) : null;

  const handleSave = () => {
    if (!isValid) return;
    onSave({ ...(initial ?? {}), id: normalizedId, label: label.trim(), color });
  };

  return (
    <View style={styles.form}>
      {nested && !initial && keywords.length > 0 && (
        <View>
          <Text style={styles.formLabel}>{t('settings.keywords.parent_field', 'Parent tag')}</Text>
          <Select value={parentId} onChange={setParentId} options={parentOptions} />
        </View>
      )}
      {nested && initial && initialParent && (
        <View>
          <Text style={styles.formLabel}>{t('settings.keywords.parent_field', 'Parent tag')}</Text>
          <Text style={styles.kwLabel}>{formatKeyword(initialParent, keywords, true)}</Text>
        </View>
      )}
      <View>
        <Text style={styles.formLabel}>{t('settings.keywords.label_field', "Display Name")}</Text>
        <TextInput accessibilityLabel={t('settings.keywords.label_field', "Display Name")}
          value={label}
          onChangeText={setLabel}
          placeholder={t('settings.keywords.label_placeholder', "e.g. Work, Personal, Urgent")}
          placeholderTextColor={c.mutedForeground}
          style={styles.input}
          maxLength={30}
          autoFocus
        />
        {nested && normalizedId.length > 0 && <Text style={[styles.kwId, { marginTop: 4 }]}>$label:{normalizedId}</Text>}
        {isDuplicate && <Text style={styles.errorText}>{t('settings.keywords.id_exists', "This tag ID already exists")}</Text>}
        {isTooLong && (
          <Text style={styles.errorText}>
            {t('settings.keywords.too_long', 'This tag path is too long (at most {max} characters)', { max: MAX_KEYWORD_ID_LENGTH })}
          </Text>
        )}
      </View>

      <View>
        <Text style={styles.formLabel}>{t('settings.keywords.color_field', "Color")}</Text>
        <View style={styles.palette}>
          {PALETTE_KEYS.map((key) => {
            // The colours as picked, also with colour-blind-safe colours on
            // (webmail keyword-settings.tsx draws KEYWORD_PALETTE).
            const p = (c.tagsAsPicked ?? c.tags)[key];
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
  kwCard: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.background,
  },
  kwCardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  kwCardBottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  kwVisibilityLabel: { ...typography.caption, color: c.mutedForeground },
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
    flexWrap: 'wrap',
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
  sharedBlock: { gap: spacing.sm, marginTop: spacing.lg },
  sharedTitle: { ...typography.bodySemibold, color: c.text },
  sharedAccount: { gap: spacing.sm },
  sharedAccountName: { ...typography.caption, color: c.textSecondary, fontWeight: '600' },
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
