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
import { Plus, Star, Trash2, X } from 'lucide-react-native';
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
import { jmapClient } from '../../api/jmap-client';
import type { EmailAddress, Identity } from '../../api/types';
import { useLocaleStore } from '../../stores/locale-store';
import { isValidEmail, parseRecipientList, formatRecipient } from '../../lib/recipients';
import { sanitizeDisplayName } from '../../lib/rfc5322-mailbox';
import { sanitizeSignatureHtml } from '../../lib/signature-utils';

type DraftIdentity = {
  id: string;
  name: string;
  email: string;
  /** Comma-separated `Name <addr>` lists, parsed on save. */
  replyTo: string;
  bcc: string;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
};

// Stalwart caps signatures at 2047 bytes (webmail identity-form.tsx).
const SIGNATURE_MAX_BYTES = 2047;

function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) n += 1;
    else if (code < 0x800) n += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

function formatAddressList(list: EmailAddress[] | undefined): string {
  return (list ?? []).filter((a) => !!a.email).map((a) => formatRecipient(a.name, a.email)).join(', ');
}

function toDraft(identity: Identity): DraftIdentity {
  return {
    id: identity.id,
    name: identity.name ?? '',
    email: identity.email,
    replyTo: formatAddressList(identity.replyTo),
    bcc: formatAddressList(identity.bcc),
    textSignature: identity.textSignature ?? '',
    htmlSignature: identity.htmlSignature ?? '',
    mayDelete: identity.mayDelete,
  };
}

function emptyDraft(): DraftIdentity {
  return { id: '', name: '', email: '', replyTo: '', bcc: '', textSignature: '', htmlSignature: '', mayDelete: true };
}

/** Parse a comma list into addresses; returns the invalid entries too. */
function parseAddressList(value: string): { list: EmailAddress[]; invalid: string[] } {
  const list: EmailAddress[] = [];
  const invalid: string[] = [];
  if (!value.trim()) return { list, invalid };
  for (const r of parseRecipientList(value)) {
    if (r.group || !isValidEmail(r.email)) {
      invalid.push(r.email || r.name || value);
      continue;
    }
    list.push(r.name ? { name: r.name, email: r.email } : { email: r.email });
  }
  return { list, invalid };
}

export function IdentitySettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const identities = useSettingsStore((s) => s.identities);
  const t = useLocaleStore((s) => s.t);
  const loading = useSettingsStore((s) => s.loading);
  const error = useSettingsStore((s) => s.error);
  const fetchIdentities = useSettingsStore((s) => s.fetchIdentities);
  const preferredIdentityIds = useSettingsStore((s) => s.preferredIdentityIds);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const accountId = jmapClient.isConnected ? jmapClient.accountId : '';
  const preferredId = accountId ? preferredIdentityIds[accountId] : undefined;

  const [editing, setEditing] = useState<DraftIdentity | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    void fetchIdentities();
  }, [fetchIdentities]);

  const openCreate = () => setEditing(emptyDraft());
  const openEdit = (i: Identity) => setEditing(toDraft(i));
  const closeEditor = () => setEditing(null);

  const setAsDefault = (identity: Identity) => {
    if (!accountId) return;
    const next = { ...preferredIdentityIds };
    if (preferredId === identity.id) delete next[accountId];
    else next[accountId] = identity.id;
    updateSetting('preferredIdentityIds', next);
  };

  const saveDraft = async () => {
    if (!editing) return;
    // A display name that carries an address or a line break would produce a
    // malformed From on every message sent with the identity.
    const name = sanitizeDisplayName(editing.name);
    const email = editing.email.trim();
    if (!email || !isValidEmail(email)) {
      Alert.alert(t('settings.identities.invalid_email_title', "Invalid email"), t('settings.identities.invalid_email', "Enter a valid email address for this identity."));
      return;
    }
    const replyTo = parseAddressList(editing.replyTo);
    const bcc = parseAddressList(editing.bcc);
    const invalid = [...replyTo.invalid, ...bcc.invalid];
    if (invalid.length) {
      Alert.alert(
        t('settings.identities.invalid_email_title', "Invalid email"),
        t('identities.validation_errors.invalid_emails', 'Invalid emails: {emails}', { emails: invalid.join(', ') }),
      );
      return;
    }
    const htmlSignature = sanitizeSignatureHtml(editing.htmlSignature);
    if (utf8Bytes(htmlSignature) > SIGNATURE_MAX_BYTES || utf8Bytes(editing.textSignature) > SIGNATURE_MAX_BYTES) {
      Alert.alert(
        t('identities.form.signature_byte_limit_reached', 'Server limit reached'),
        t('identities.form.signature_byte_counter', '{bytes} / {max} bytes', {
          bytes: Math.max(utf8Bytes(htmlSignature), utf8Bytes(editing.textSignature)), max: SIGNATURE_MAX_BYTES,
        }),
      );
      return;
    }
    setSaving(true);
    try {
      const patch: Partial<Identity> = {
        name,
        replyTo: replyTo.list.length ? replyTo.list : undefined,
        bcc: bcc.list.length ? bcc.list : undefined,
        textSignature: editing.textSignature,
        htmlSignature,
      };
      if (editing.id) {
        // JMAP doesn't allow changing `email` on an existing identity, so we
        // only PATCH the editable fields. The server will reject email
        // changes; the form disables that input below to make this obvious.
        await updateIdentity(editing.id, {
          ...patch,
          // Clearing a list needs an explicit null, not an omitted key.
          replyTo: patch.replyTo ?? (null as unknown as EmailAddress[]),
          bcc: patch.bcc ?? (null as unknown as EmailAddress[]),
        });
      } else {
        await createIdentity({
          ...patch,
          email,
          textSignature: editing.textSignature || undefined,
          htmlSignature: htmlSignature || undefined,
        });
      }
      closeEditor();
      await fetchIdentities();
    } catch (err) {
      Alert.alert(t('settings.identities.save_failed', "Save failed"), err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (identity: Identity) => {
    if (!identity.mayDelete) {
      Alert.alert(t('settings.identities.cannot_delete_title', "Cannot delete"), t('settings.identities.cannot_delete', "The primary identity cannot be removed."));
      return;
    }
    Alert.alert(
      t('settings.identities.delete_title', "Delete identity"),
      t('settings.identities.delete_confirm', 'Remove "{name}"?', { name: identity.name || identity.email }),
      [
        { text: t('common.cancel', "Cancel"), style: 'cancel' },
        {
          text: t('common.delete', "Delete"),
          style: 'destructive',
          onPress: async () => {
            setDeletingId(identity.id);
            try {
              await deleteIdentity(identity.id);
              await fetchIdentities();
            } catch (err) {
              Alert.alert(t('settings.identities.delete_failed', "Delete failed"), err instanceof Error ? err.message : String(err));
            } finally {
              setDeletingId(null);
            }
          },
        },
      ],
    );
  };

  const htmlBytes = utf8Bytes(editing?.htmlSignature ?? '');
  const textBytes = utf8Bytes(editing?.textSignature ?? '');

  return (
    <SettingsSection
      title={t('settings.identities.title', "Sending Identities")}
      description={t('settings.identities.description_mobile', "Manage sender names, email addresses, and signatures. Tap a row to edit.")}
    >
      <View style={styles.headerRow}>
        <Text style={styles.count}>
          {loading
            ? t('common.loading', "Loading...")
            : t('settings.identities.count', '{count, plural, =0 {No identities} one {# identity} other {# identities}}', { count: identities.length })}
        </Text>
        <Button
          variant="default"
          size="sm"
          onPress={openCreate}
          icon={<Plus size={14} color={c.primaryForeground} />}
          disabled={loading}
        >
          {t('settings.identities.new', "New")}
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
            <Text style={styles.identityName}>{identity.name || t('settings.identities.no_name', "(no name)")}</Text>
            <Text style={styles.identityEmail}>{identity.email}</Text>
          </View>
          {identities.length > 1 && (
            <Pressable
              onPress={() => setAsDefault(identity)}
              hitSlop={8}
              style={styles.identityDelete}
              accessibilityRole="button"
              accessibilityLabel={t('identities.set_as_primary', 'Set as primary')}
            >
              <Star
                size={16}
                color={preferredId === identity.id ? c.primary : c.textMuted}
                fill={preferredId === identity.id ? c.primary : 'transparent'}
              />
            </Pressable>
          )}
          {!identity.mayDelete ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{t('settings.identities.primary', "primary")}</Text>
            </View>
          ) : (
            <Pressable
              onPress={() => confirmDelete(identity)}
              hitSlop={8}
              style={styles.identityDelete}
              disabled={deletingId === identity.id}
              accessibilityRole="button"
              accessibilityLabel={t('common.delete', "Delete")}
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
                {editing?.id ? t('settings.identities.edit', "Edit identity") : t('settings.identities.create', "New identity")}
              </Text>
              <Pressable onPress={closeEditor} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close', "Close")}>
                <X size={20} color={c.text} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.fieldLabel}>{t('settings.identities.display_name', "Display name")}</Text>
              <TextInput
                value={editing?.name ?? ''}
                onChangeText={(name) => setEditing((d) => (d ? { ...d, name } : d))}
                placeholder={t('settings.identities.display_name_placeholder', 'Jane Doe')}
                placeholderTextColor={c.textMuted}
                style={styles.input}
              />
              <Text style={styles.fieldLabel}>{t('settings.identities.email_address', "Email address")}</Text>
              <TextInput
                value={editing?.email ?? ''}
                onChangeText={(email) => setEditing((d) => (d ? { ...d, email } : d))}
                placeholder={t('identities.form.email_placeholder', 'your.email@example.com')}
                placeholderTextColor={c.textMuted}
                style={[styles.input, !!editing?.id && styles.inputDisabled]}
                editable={!editing?.id}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
              />
              {!!editing?.id && (
                <Text style={styles.hint}>{t('settings.identities.email_locked', "JMAP does not allow changing an identity's email; create a new one instead.")}</Text>
              )}
              <Text style={styles.fieldLabel}>{t('identities.form.reply_to_label', 'Reply-To (optional)')}</Text>
              <TextInput
                value={editing?.replyTo ?? ''}
                onChangeText={(replyTo) => setEditing((d) => (d ? { ...d, replyTo } : d))}
                placeholder={t('identities.form.reply_to_placeholder', 'different@example.com')}
                placeholderTextColor={c.textMuted}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
              />
              <Text style={styles.fieldLabel}>{t('identities.form.bcc_label', 'Auto BCC (optional)')}</Text>
              <TextInput
                value={editing?.bcc ?? ''}
                onChangeText={(bcc) => setEditing((d) => (d ? { ...d, bcc } : d))}
                placeholder={t('identities.form.bcc_placeholder', 'archive@example.com')}
                placeholderTextColor={c.textMuted}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
              />
              <Text style={styles.fieldLabel}>{t('identities.form.text_signature_label', "Text Signature")}</Text>
              <TextInput
                value={editing?.textSignature ?? ''}
                onChangeText={(textSignature) => setEditing((d) => (d ? { ...d, textSignature } : d))}
                placeholder="--&#10;Jane Doe&#10;Bulwark Mail"
                placeholderTextColor={c.textMuted}
                multiline
                style={[styles.input, styles.bodyInput]}
              />
              <Text style={[styles.hint, textBytes > SIGNATURE_MAX_BYTES && styles.hintError]}>
                {t('identities.form.signature_byte_counter', '{bytes} / {max} bytes', { bytes: textBytes, max: SIGNATURE_MAX_BYTES })}
              </Text>
              <Text style={styles.fieldLabel}>{t('identities.form.html_signature_label', "HTML Signature")}</Text>
              <TextInput
                value={editing?.htmlSignature ?? ''}
                onChangeText={(htmlSignature) => setEditing((d) => (d ? { ...d, htmlSignature } : d))}
                placeholder="<p><b>Jane Doe</b><br>Bulwark Mail</p>"
                placeholderTextColor={c.textMuted}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.input, styles.bodyInput, styles.mono]}
              />
              <Text style={[styles.hint, htmlBytes > SIGNATURE_MAX_BYTES && styles.hintError]}>
                {t('identities.form.signature_byte_counter', '{bytes} / {max} bytes', { bytes: htmlBytes, max: SIGNATURE_MAX_BYTES })}
              </Text>
            </ScrollView>
            <View style={styles.modalActions}>
              <Button variant="outline" size="sm" onPress={closeEditor} disabled={saving}>{t('common.cancel', "Cancel")}</Button>
              <Button
                variant="default"
                size="sm"
                onPress={() => { void saveDraft(); }}
                loading={saving}
              >
                {t('common.save', "Save")}
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
      backgroundColor: c.primaryBg,
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
    mono: { fontFamily: 'monospace', fontSize: 13 },
    hint: { ...typography.caption, color: c.mutedForeground },
    hintError: { color: c.error },
    modalActions: {
      flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm,
      padding: spacing.lg, borderTopWidth: 1, borderTopColor: c.border,
    },
  });
}
