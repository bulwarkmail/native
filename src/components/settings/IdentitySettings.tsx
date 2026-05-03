import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Plus, Trash2, X } from 'lucide-react-native';
import { SettingsSection } from './settings-section';
import Button from '../Button';
import { typography, spacing, radius, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import {
  createIdentity,
  deleteIdentity,
  updateIdentity,
} from '../../api/identity';
import type { Identity } from '../../api/types';

type DraftIdentity = {
  id: string;
  name: string;
  email: string;
  textSignature: string;
  mayDelete: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toDraft(identity: Identity): DraftIdentity {
  return {
    id: identity.id,
    name: identity.name ?? '',
    email: identity.email,
    textSignature: identity.textSignature ?? '',
    mayDelete: identity.mayDelete,
  };
}

function emptyDraft(): DraftIdentity {
  return { id: '', name: '', email: '', textSignature: '', mayDelete: true };
}

export function IdentitySettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const identities = useSettingsStore((s) => s.identities);
  const loading = useSettingsStore((s) => s.loading);
  const error = useSettingsStore((s) => s.error);
  const fetchIdentities = useSettingsStore((s) => s.fetchIdentities);

  const [editing, setEditing] = useState<DraftIdentity | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    void fetchIdentities();
  }, [fetchIdentities]);

  const openCreate = () => setEditing(emptyDraft());
  const openEdit = (i: Identity) => setEditing(toDraft(i));
  const closeEditor = () => setEditing(null);

  const saveDraft = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    const email = editing.email.trim();
    if (!email || !EMAIL_RE.test(email)) {
      Alert.alert('Invalid email', 'Enter a valid email address for this identity.');
      return;
    }
    setSaving(true);
    try {
      if (editing.id) {
        // JMAP doesn't allow changing `email` on an existing identity, so we
        // only PATCH the editable fields. The server will reject email
        // changes; the form disables that input below to make this obvious.
        await updateIdentity(editing.id, {
          name,
          textSignature: editing.textSignature,
        });
      } else {
        await createIdentity({
          name,
          email,
          textSignature: editing.textSignature || undefined,
        });
      }
      closeEditor();
      await fetchIdentities();
    } catch (err) {
      Alert.alert('Save failed', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (identity: Identity) => {
    if (!identity.mayDelete) {
      Alert.alert('Cannot delete', 'The primary identity cannot be removed.');
      return;
    }
    Alert.alert(
      'Delete identity',
      `Remove "${identity.name || identity.email}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingId(identity.id);
            try {
              await deleteIdentity(identity.id);
              await fetchIdentities();
            } catch (err) {
              Alert.alert('Delete failed', err instanceof Error ? err.message : String(err));
            } finally {
              setDeletingId(null);
            }
          },
        },
      ],
    );
  };

  return (
    <SettingsSection
      title="Identities"
      description="Manage sender names, email addresses, and signatures. Tap a row to edit."
    >
      <View style={styles.headerRow}>
        <Text style={styles.count}>
          {loading ? 'Loading…' : identities.length === 1 ? '1 identity' : `${identities.length} identities`}
        </Text>
        <Button
          variant="default"
          size="sm"
          onPress={openCreate}
          icon={<Plus size={14} color={c.primaryForeground} />}
          disabled={loading}
        >
          New
        </Button>
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {identities.map((identity) => (
        <Pressable
          key={identity.id}
          onPress={() => openEdit(identity)}
          style={({ pressed }) => [styles.identityRow, pressed && styles.identityRowPressed]}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.identityName}>{identity.name || '(no name)'}</Text>
            <Text style={styles.identityEmail}>{identity.email}</Text>
          </View>
          {!identity.mayDelete ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>primary</Text>
            </View>
          ) : (
            <Pressable
              onPress={() => confirmDelete(identity)}
              hitSlop={8}
              style={styles.identityDelete}
              disabled={deletingId === identity.id}
            >
              {deletingId === identity.id ? (
                <ActivityIndicator size="small" color={c.error} />
              ) : (
                <Trash2 size={16} color={c.error} />
              )}
            </Pressable>
          )}
        </Pressable>
      ))}

      <Modal visible={!!editing} animationType="slide" transparent onRequestClose={closeEditor}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editing?.id ? 'Edit identity' : 'New identity'}
              </Text>
              <Pressable onPress={closeEditor} hitSlop={8}>
                <X size={20} color={c.text} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.modalBody}>
              <Text style={styles.fieldLabel}>Display name</Text>
              <TextInput
                value={editing?.name ?? ''}
                onChangeText={(name) => setEditing((d) => (d ? { ...d, name } : d))}
                placeholder="Jane Doe"
                placeholderTextColor={c.textMuted}
                style={styles.input}
              />
              <Text style={styles.fieldLabel}>Email address</Text>
              <TextInput
                value={editing?.email ?? ''}
                onChangeText={(email) => setEditing((d) => (d ? { ...d, email } : d))}
                placeholder="jane@example.com"
                placeholderTextColor={c.textMuted}
                style={[styles.input, !!editing?.id && styles.inputDisabled]}
                editable={!editing?.id}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
              />
              {!!editing?.id && (
                <Text style={styles.hint}>JMAP does not allow changing an identity&apos;s email; create a new one instead.</Text>
              )}
              <Text style={styles.fieldLabel}>Plain-text signature</Text>
              <TextInput
                value={editing?.textSignature ?? ''}
                onChangeText={(textSignature) => setEditing((d) => (d ? { ...d, textSignature } : d))}
                placeholder="--&#10;Jane Doe&#10;Bulwark Mail"
                placeholderTextColor={c.textMuted}
                multiline
                style={[styles.input, styles.bodyInput]}
              />
            </ScrollView>
            <View style={styles.modalActions}>
              <Button variant="outline" size="sm" onPress={closeEditor} disabled={saving}>Cancel</Button>
              <Button
                variant="default"
                size="sm"
                onPress={() => { void saveDraft(); }}
                loading={saving}
              >
                Save
              </Button>
            </View>
          </View>
        </View>
      </Modal>
    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    headerRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: spacing.sm,
    },
    count: { ...typography.body, color: c.mutedForeground },
    errorBox: { padding: spacing.md, borderRadius: radius.sm, backgroundColor: c.errorBg },
    errorText: { ...typography.caption, color: c.error },
    identityRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing.md,
      paddingVertical: spacing.md, paddingHorizontal: spacing.md,
      borderRadius: radius.sm, backgroundColor: c.muted,
      marginTop: spacing.xs,
    },
    identityRowPressed: { backgroundColor: c.surfaceHover },
    identityName: { ...typography.bodyMedium, color: c.text },
    identityEmail: { ...typography.caption, color: c.mutedForeground, marginTop: 2 },
    identityDelete: { padding: 6 },
    badge: {
      paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full,
      backgroundColor: 'rgba(59,130,246,0.15)',
    },
    badgeText: { fontSize: 10, fontWeight: '500', color: c.primary },

    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
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
    inputDisabled: { opacity: 0.6 },
    bodyInput: { minHeight: 100, textAlignVertical: 'top' },
    hint: { ...typography.caption, color: c.mutedForeground },
    modalActions: {
      flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm,
      padding: spacing.lg, borderTopWidth: 1, borderTopColor: c.border,
    },
  });
}
