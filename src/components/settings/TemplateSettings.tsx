import React, { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Download, FileText, Plus, Star, Trash2, Upload, X } from 'lucide-react-native';
import { SettingsSection, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useTemplatesStore, type EmailTemplate } from '../../stores/templates-store';
import { useLocaleStore } from '../../stores/locale-store';

export function TemplateSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const tr = useLocaleStore((s) => s.t);
  const templates = useTemplatesStore((s) => s.templates);
  const hydrated = useTemplatesStore((s) => s.hydrated);
  const hydrate = useTemplatesStore((s) => s.hydrate);
  const addTemplate = useTemplatesStore((s) => s.addTemplate);
  const updateTemplate = useTemplatesStore((s) => s.updateTemplate);
  const deleteTemplate = useTemplatesStore((s) => s.deleteTemplate);
  const exportAll = useTemplatesStore((s) => s.exportAll);
  const importTemplates = useTemplatesStore((s) => s.importTemplates);

  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [importVisible, setImportVisible] = useState(false);
  const [importText, setImportText] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftSubject, setDraftSubject] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftCategory, setDraftCategory] = useState('');
  const [draftFavorite, setDraftFavorite] = useState(false);
  const [draftIsHtml, setDraftIsHtml] = useState(false);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const openCreate = () => {
    setEditing({
      id: '',
      name: '',
      subject: '',
      body: '',
      category: '',
      isFavorite: false,
      createdAt: '',
      updatedAt: '',
    });
    setDraftName('');
    setDraftSubject('');
    setDraftBody('');
    setDraftCategory('');
    setDraftFavorite(false);
    setDraftIsHtml(false);
  };

  const openEdit = (t: EmailTemplate) => {
    setEditing(t);
    setDraftName(t.name);
    setDraftSubject(t.subject);
    setDraftBody(t.body);
    setDraftCategory(t.category);
    setDraftFavorite(t.isFavorite);
    setDraftIsHtml(!!t.isHTML);
  };

  const closeEditor = () => setEditing(null);

  const saveDraft = () => {
    const name = draftName.trim();
    if (!name) {
      Alert.alert(tr('settings.templates.validation.empty', "Template name is required"));
      return;
    }
    if (!editing) return;
    const fields = {
      name, subject: draftSubject, body: draftBody,
      category: draftCategory.trim(), isFavorite: draftFavorite, isHTML: draftIsHtml,
    };
    if (editing.id) {
      updateTemplate(editing.id, fields);
    } else {
      addTemplate(fields);
    }
    closeEditor();
  };

  const confirmDelete = (t: EmailTemplate) => {
    Alert.alert(
      tr('settings.templates.delete_title', "Delete template"),
      tr('settings.templates.delete_confirm', 'Permanently delete "{name}"?', { name: t.name }),
      [
        { text: tr('common.cancel', 'Cancel'), style: 'cancel' },
        { text: tr('common.delete', 'Delete'), style: 'destructive', onPress: () => deleteTemplate(t.id) },
      ],
    );
  };

  const exportTemplatesAsShare = async () => {
    const json = exportAll();
    try {
      await Share.share({ message: json, title: tr('settings.templates.export', 'Export') });
    } catch (err) {
      Alert.alert(tr('settings.templates.export_failed', 'Export failed'), err instanceof Error ? err.message : tr('settings.templates.share_unavailable', 'Unable to share'));
    }
  };

  const performImport = () => {
    const result = importTemplates(importText);
    if (result.error) {
      Alert.alert(tr('settings.templates.import_failed', 'Import failed'), result.error);
      return;
    }
    setImportText('');
    setImportVisible(false);
    Alert.alert(
      tr('settings.templates.imported', 'Imported'),
      tr('settings.templates.imported_count', '{count, plural, one {# template} other {# templates}} added.', { count: result.count }),
    );
  };

  return (
    <View style={styles.container}>
      <SettingsSection title={tr('settings.templates.title', 'Email Templates')} description={tr('settings.templates.description_mobile', 'Reusable snippets for common replies. Tap one to edit; long-press to delete.')}>
        <View style={styles.headerRow}>
          <View style={styles.countRow}>
            <FileText size={16} color={c.mutedForeground} />
            <Text style={styles.count}>
              {tr('settings.templates.count', '{count, plural, one {# template} other {# templates}}', { count: templates.length })}
            </Text>
          </View>
          <Button variant="default" size="sm" onPress={openCreate} icon={<Plus size={14} color={c.primaryForeground} />}>
            {tr('settings.templates.add', 'New Template')}
          </Button>
        </View>

        {templates.length === 0 ? (
          <Text style={styles.emptyHint}>{tr('settings.templates.no_templates', 'No templates yet')}</Text>
        ) : (
          <View style={styles.list}>
            {templates.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => openEdit(t)}
                onLongPress={() => confirmDelete(t)}
                style={({ pressed }) => [styles.listRow, pressed && styles.listRowPressed]}
              >
                {t.isFavorite && <Star size={14} color={c.primary} fill={c.primary} />}
                <View style={styles.listRowText}>
                  <Text style={styles.listRowName} numberOfLines={1}>{t.name}</Text>
                  {!!(t.subject || t.category) && (
                    <Text style={styles.listRowSubject} numberOfLines={1}>
                      {[t.category, t.subject].filter(Boolean).join(' · ')}
                    </Text>
                  )}
                </View>
                <Pressable onPress={() => confirmDelete(t)} hitSlop={8} style={styles.listRowDelete} accessibilityRole="button" accessibilityLabel={tr('common.delete', 'Delete')}>
                  <Trash2 size={16} color={c.error} />
                </Pressable>
              </Pressable>
            ))}
          </View>
        )}
      </SettingsSection>

      <SettingsSection title={tr('settings.templates.export_import', 'Export & Import')} description={tr('settings.templates.export_import_description', 'Back up your templates or transfer them to another device')}>
        <View style={styles.actions}>
          <Button
            variant="outline"
            size="sm"
            disabled={templates.length === 0}
            icon={<Download size={14} color={c.text} />}
            onPress={() => { void exportTemplatesAsShare(); }}
          >
            {tr('settings.templates.export', 'Export')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon={<Upload size={14} color={c.text} />}
            onPress={() => setImportVisible(true)}
          >
            {tr('settings.templates.import', 'Import')}
          </Button>
        </View>
      </SettingsSection>

      {/* Edit/Create modal */}
      <Modal visible={!!editing} animationType="slide" transparent onRequestClose={closeEditor}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editing?.id ? tr('settings.templates.edit', 'Edit Template') : tr('settings.templates.add', 'New Template')}
              </Text>
              <Pressable onPress={closeEditor} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr('common.close', 'Close')}>
                <X size={20} color={c.text} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.modalBody}>
              <Text style={styles.fieldLabel}>{tr('settings.templates.name', 'Template Name')}</Text>
              <TextInput
                value={draftName}
                onChangeText={setDraftName}
                placeholder={tr('settings.templates.name_placeholder', 'e.g., Follow-up email')}
                placeholderTextColor={c.textMuted}
                style={styles.input}
              />
              <Text style={styles.fieldLabel}>{tr('settings.templates.subject', 'Subject')}</Text>
              <TextInput
                value={draftSubject}
                onChangeText={setDraftSubject}
                placeholder={tr('settings.templates.subject_placeholder', 'Email subject line')}
                placeholderTextColor={c.textMuted}
                style={styles.input}
              />
              <Text style={styles.fieldLabel}>{tr('settings.templates.category', 'Category')}</Text>
              <TextInput
                value={draftCategory}
                onChangeText={setDraftCategory}
                placeholder={tr('settings.templates.category_placeholder', 'e.g., Work, Personal')}
                placeholderTextColor={c.textMuted}
                style={styles.input}
              />
              <Text style={styles.fieldLabel}>{tr('settings.templates.body', 'Body')}</Text>
              <TextInput
                value={draftBody}
                onChangeText={setDraftBody}
                placeholder={tr('settings.templates.body_placeholder', 'Email body content...')}
                placeholderTextColor={c.textMuted}
                multiline
                style={[styles.input, styles.bodyInput]}
              />
              <Text style={styles.hint}>
                {tr('settings.templates.placeholders_hint', 'Placeholders: {{recipient_name}}, {{company}}, {{date}}, {{day_of_week}}, {{sender_name}}')}
              </Text>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>{tr('settings.templates.favorite', 'Favorite')}</Text>
                <ToggleSwitch
                  checked={draftFavorite}
                  onChange={setDraftFavorite}
                  accessibilityLabel={tr('settings.templates.favorite', 'Favorite')}
                />
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>{tr('settings.templates.is_html', 'Body is HTML')}</Text>
                <ToggleSwitch
                  checked={draftIsHtml}
                  onChange={setDraftIsHtml}
                  accessibilityLabel={tr('settings.templates.is_html', 'Body is HTML')}
                />
              </View>
            </ScrollView>
            <View style={styles.modalActions}>
              <Button variant="outline" size="sm" onPress={closeEditor}>{tr('common.cancel', 'Cancel')}</Button>
              <Button variant="default" size="sm" onPress={saveDraft}>{tr('common.save', 'Save')}</Button>
            </View>
          </View>
        </View>
      </Modal>

      {/* Import modal */}
      <Modal visible={importVisible} animationType="slide" transparent onRequestClose={() => setImportVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{tr('settings.templates.import', 'Import')}</Text>
              <Pressable onPress={() => setImportVisible(false)} hitSlop={8} accessibilityRole="button" accessibilityLabel={tr('common.close', 'Close')}>
                <X size={20} color={c.text} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.modalBody}>
              <Text style={styles.fieldLabel}>JSON</Text>
              <TextInput
                value={importText}
                onChangeText={setImportText}
                placeholder='{"templates": [...]}'
                placeholderTextColor={c.textMuted}
                multiline
                style={[styles.input, styles.bodyInput]}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </ScrollView>
            <View style={styles.modalActions}>
              <Button variant="outline" size="sm" onPress={() => setImportVisible(false)}>{tr('common.cancel', 'Cancel')}</Button>
              <Button variant="default" size="sm" onPress={performImport} disabled={!importText.trim()}>
                {tr('settings.templates.import', 'Import')}
              </Button>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { gap: spacing.xxxl },
    headerRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: spacing.md,
    },
    countRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    count: { ...typography.body, color: c.mutedForeground },
    emptyHint: { ...typography.caption, color: c.mutedForeground, paddingVertical: spacing.md },
    list: { gap: spacing.sm },
    listRow: {
      flexDirection: 'row', alignItems: 'center',
      borderWidth: 1, borderColor: c.border, borderRadius: radius.md,
      padding: spacing.md, gap: spacing.md,
    },
    listRowPressed: { backgroundColor: c.surface },
    listRowText: { flex: 1 },
    listRowName: { ...typography.bodyMedium, color: c.text },
    listRowSubject: { ...typography.caption, color: c.mutedForeground, marginTop: 2 },
    listRowDelete: { padding: 4 },
    actions: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.md, flexWrap: 'wrap' },

    modalOverlay: {
      flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    modalSheet: {
      backgroundColor: c.background,
      borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
      maxHeight: '90%',
    },
    modalHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
      borderBottomWidth: 1, borderBottomColor: c.border,
    },
    modalTitle: { ...typography.h3, color: c.text },
    modalBody: { padding: spacing.lg, gap: spacing.sm },
    fieldLabel: { ...typography.captionMedium, color: c.textSecondary, marginTop: spacing.sm },
    input: {
      ...typography.body, color: c.text,
      backgroundColor: c.surface,
      borderWidth: 1, borderColor: c.border, borderRadius: radius.sm,
      paddingHorizontal: spacing.md, paddingVertical: 10,
    },
    bodyInput: { minHeight: 160, textAlignVertical: 'top' },
    hint: { ...typography.caption, color: c.mutedForeground },
    toggleRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: spacing.sm,
    },
    toggleLabel: { ...typography.body, color: c.text },
    modalActions: {
      flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm,
      padding: spacing.lg,
      borderTopWidth: 1, borderTopColor: c.border,
    },
  });
}
