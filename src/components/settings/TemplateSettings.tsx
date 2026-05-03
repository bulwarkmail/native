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
import { Download, FileText, Plus, Trash2, Upload, X } from 'lucide-react-native';
import { SettingsSection } from './settings-section';
import Button from '../Button';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useTemplatesStore, type EmailTemplate } from '../../stores/templates-store';

export function TemplateSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
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
  };

  const openEdit = (t: EmailTemplate) => {
    setEditing(t);
    setDraftName(t.name);
    setDraftSubject(t.subject);
    setDraftBody(t.body);
  };

  const closeEditor = () => setEditing(null);

  const saveDraft = () => {
    const name = draftName.trim();
    if (!name) {
      Alert.alert('Template name required');
      return;
    }
    if (!editing) return;
    if (editing.id) {
      updateTemplate(editing.id, { name, subject: draftSubject, body: draftBody });
    } else {
      addTemplate({ name, subject: draftSubject, body: draftBody });
    }
    closeEditor();
  };

  const confirmDelete = (t: EmailTemplate) => {
    Alert.alert(
      'Delete template',
      `Permanently delete "${t.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteTemplate(t.id) },
      ],
    );
  };

  const exportTemplatesAsShare = async () => {
    const json = exportAll();
    try {
      await Share.share({ message: json, title: 'Templates export' });
    } catch (err) {
      Alert.alert('Export failed', err instanceof Error ? err.message : 'Unable to share');
    }
  };

  const performImport = () => {
    const result = importTemplates(importText);
    if (result.error) {
      Alert.alert('Import failed', result.error);
      return;
    }
    setImportText('');
    setImportVisible(false);
    Alert.alert('Imported', `${result.count} template${result.count === 1 ? '' : 's'} added.`);
  };

  return (
    <View style={styles.container}>
      <SettingsSection title="Templates" description="Reusable snippets for common replies. Tap one to edit; long-press to delete.">
        <View style={styles.headerRow}>
          <View style={styles.countRow}>
            <FileText size={16} color={c.mutedForeground} />
            <Text style={styles.count}>
              {templates.length === 1 ? '1 template' : `${templates.length} templates`}
            </Text>
          </View>
          <Button variant="default" size="sm" onPress={openCreate} icon={<Plus size={14} color={c.primaryForeground} />}>
            New
          </Button>
        </View>

        {templates.length === 0 ? (
          <Text style={styles.emptyHint}>No templates yet. Tap "New" to add one.</Text>
        ) : (
          <View style={styles.list}>
            {templates.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => openEdit(t)}
                onLongPress={() => confirmDelete(t)}
                style={({ pressed }) => [styles.listRow, pressed && styles.listRowPressed]}
              >
                <View style={styles.listRowText}>
                  <Text style={styles.listRowName} numberOfLines={1}>{t.name}</Text>
                  {!!t.subject && (
                    <Text style={styles.listRowSubject} numberOfLines={1}>{t.subject}</Text>
                  )}
                </View>
                <Pressable onPress={() => confirmDelete(t)} hitSlop={8} style={styles.listRowDelete}>
                  <Trash2 size={16} color={c.error} />
                </Pressable>
              </Pressable>
            ))}
          </View>
        )}
      </SettingsSection>

      <SettingsSection title="Export / Import" description="Back up or restore your templates as JSON.">
        <View style={styles.actions}>
          <Button
            variant="outline"
            size="sm"
            disabled={templates.length === 0}
            icon={<Download size={14} color={c.text} />}
            onPress={() => { void exportTemplatesAsShare(); }}
          >
            Share JSON
          </Button>
          <Button
            variant="outline"
            size="sm"
            icon={<Upload size={14} color={c.text} />}
            onPress={() => setImportVisible(true)}
          >
            Import
          </Button>
        </View>
      </SettingsSection>

      {/* Edit/Create modal */}
      <Modal visible={!!editing} animationType="slide" transparent onRequestClose={closeEditor}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editing?.id ? 'Edit template' : 'New template'}
              </Text>
              <Pressable onPress={closeEditor} hitSlop={8}>
                <X size={20} color={c.text} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.modalBody}>
              <Text style={styles.fieldLabel}>Name</Text>
              <TextInput
                value={draftName}
                onChangeText={setDraftName}
                placeholder="Quick reply"
                placeholderTextColor={c.textMuted}
                style={styles.input}
              />
              <Text style={styles.fieldLabel}>Subject</Text>
              <TextInput
                value={draftSubject}
                onChangeText={setDraftSubject}
                placeholder="(optional)"
                placeholderTextColor={c.textMuted}
                style={styles.input}
              />
              <Text style={styles.fieldLabel}>Body</Text>
              <TextInput
                value={draftBody}
                onChangeText={setDraftBody}
                placeholder="Hi {recipient_name}, …"
                placeholderTextColor={c.textMuted}
                multiline
                style={[styles.input, styles.bodyInput]}
              />
            </ScrollView>
            <View style={styles.modalActions}>
              <Button variant="outline" size="sm" onPress={closeEditor}>Cancel</Button>
              <Button variant="default" size="sm" onPress={saveDraft}>Save</Button>
            </View>
          </View>
        </View>
      </Modal>

      {/* Import modal */}
      <Modal visible={importVisible} animationType="slide" transparent onRequestClose={() => setImportVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Import templates</Text>
              <Pressable onPress={() => setImportVisible(false)} hitSlop={8}>
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
              <Button variant="outline" size="sm" onPress={() => setImportVisible(false)}>Cancel</Button>
              <Button variant="default" size="sm" onPress={performImport} disabled={!importText.trim()}>
                Import
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
    modalActions: {
      flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm,
      padding: spacing.lg,
      borderTopWidth: 1, borderTopColor: c.border,
    },
  });
}
