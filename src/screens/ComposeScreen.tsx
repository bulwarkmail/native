import React from 'react';
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
  type NativeSyntheticEvent, type TextInputSelectionChangeEventData,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  X, Send, Paperclip, ChevronDown, Bold, Italic, List, ListOrdered,
  Link2, Image as ImageIcon, Quote, FileText,
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { Button } from '../components';
import { useEmailStore } from '../stores/email-store';
import { useContactsStore } from '../stores/contacts-store';
import { useLocaleStore } from '../stores/locale-store';
import { isGroup } from '../lib/contact-utils';
import {
  getContactDisplayName,
  getContactInitials,
  matchesContactSearch,
} from '../lib/contact-utils';
import { getIdentities } from '../api/identity';
import { sendEmail, type OutgoingAttachment } from '../api/email';
import { uploadBlob } from '../api/blob';
import {
  markdownToHtml,
  wrapSelection,
  toggleLinePrefix,
  formatReplyQuote,
} from '../lib/compose-format';
import type { EmailAddress, Identity, ContactCard } from '../api/types';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Compose'>;

interface Recipient {
  name: string;
  email: string;
}

type AttachmentEntry = {
  localId: string;
  name: string;
  type: string;
  size: number;
  uri: string;
  inline: boolean;
  cid?: string;
  blobId?: string;
  uploading: boolean;
  error?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+/i;

function parseRecipients(input: string): Recipient[] {
  return input
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((email) => ({ name: '', email }));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function genCid(): string {
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}@bulwark.local`;
}

function genLocalId(): string {
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
}

function RecipientChip({ recipient, onRemove }: { recipient: Recipient; onRemove: () => void }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText} numberOfLines={1}>
        {recipient.name || recipient.email}
      </Text>
      <Pressable onPress={onRemove} hitSlop={8}>
        <X size={12} color={c.textMuted} />
      </Pressable>
    </View>
  );
}

function SuggestionList({
  suggestions, onPick,
}: {
  suggestions: Array<{ contact: ContactCard; name: string; email: string }>;
  onPick: (s: { name: string; email: string }) => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.suggestionBox}>
      {suggestions.map((s, i) => {
        const initials = getContactInitials(s.contact);
        return (
          <Pressable
            key={`${s.contact.id}-${s.email}-${i}`}
            onPress={() => onPick(s)}
            style={({ pressed }) => [styles.suggestionRow, pressed && styles.suggestionRowPressed]}
          >
            <View style={styles.suggestionAvatar}>
              <Text style={styles.suggestionAvatarText}>{initials}</Text>
            </View>
            <View style={styles.suggestionText}>
              <Text style={styles.suggestionName} numberOfLines={1}>
                {s.name || s.email}
              </Text>
              {!!s.name && (
                <Text style={styles.suggestionEmail} numberOfLines={1}>{s.email}</Text>
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function AttachmentChip({
  attachment, onRemove,
}: {
  attachment: AttachmentEntry;
  onRemove: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.attachmentChip}>
      {attachment.uploading ? (
        <ActivityIndicator size="small" color={c.primary} />
      ) : attachment.error ? (
        <X size={14} color={c.error} />
      ) : attachment.type.startsWith('image/') ? (
        <ImageIcon size={14} color={c.textSecondary} />
      ) : (
        <FileText size={14} color={c.textSecondary} />
      )}
      <View style={styles.attachmentMeta}>
        <Text style={styles.attachmentName} numberOfLines={1}>
          {attachment.name}
        </Text>
        <Text style={styles.attachmentSize}>
          {attachment.error
            ? attachment.error
            : attachment.uploading
              ? 'Uploading...'
              : formatBytes(attachment.size)}
        </Text>
      </View>
      <Pressable onPress={onRemove} hitSlop={8} style={styles.attachmentRemove}>
        <X size={14} color={c.textMuted} />
      </Pressable>
    </View>
  );
}

export default function ComposeScreen({ route, navigation }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const replyTo = route.params?.replyTo;
  const mode = route.params?.mode;
  const prefillTo = route.params?.prefillTo;
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const sentMailbox = React.useMemo(
    () => mailboxes.find((m) => m.role === 'sent'),
    [mailboxes],
  );

  const [identities, setIdentities] = React.useState<Identity[]>([]);
  const [identityError, setIdentityError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);

  const initialTo = React.useMemo<Recipient[]>(() => {
    if (!replyTo) {
      if (prefillTo && prefillTo.length > 0) {
        return prefillTo
          .filter((r) => !!r.email)
          .map((r) => ({ name: r.name ?? '', email: r.email }));
      }
      return [];
    }
    if (mode === 'forward') return [];
    const base: Recipient[] = replyTo.from.email
      ? [{ name: replyTo.from.name ?? '', email: replyTo.from.email }]
      : [];
    if (mode === 'replyAll' && replyTo.to) {
      for (const r of replyTo.to) {
        if (r.email && !base.some((b) => b.email === r.email)) {
          base.push({ name: r.name ?? '', email: r.email });
        }
      }
    }
    return base;
  }, [replyTo, mode, prefillTo]);

  const initialCc = React.useMemo<Recipient[]>(() => {
    if (mode !== 'replyAll' || !replyTo?.cc) return [];
    return replyTo.cc
      .filter((r) => !!r.email)
      .map((r) => ({ name: r.name ?? '', email: r.email }));
  }, [replyTo, mode]);

  const initialSubject = React.useMemo(() => {
    if (!replyTo) return '';
    const s = replyTo.subject ?? '';
    if (mode === 'forward') {
      return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`;
    }
    return /^re:/i.test(s) ? s : `Re: ${s}`;
  }, [replyTo, mode]);

  const [toRecipients, setToRecipients] = React.useState<Recipient[]>(initialTo);
  const [ccRecipients, setCcRecipients] = React.useState<Recipient[]>(initialCc);
  const [ccVisible, setCcVisible] = React.useState(initialCc.length > 0);
  const [toInput, setToInput] = React.useState('');
  const [ccInput, setCcInput] = React.useState('');
  const [subject, setSubject] = React.useState(initialSubject);
  const [body, setBody] = React.useState('');
  const [bodySelection, setBodySelection] = React.useState({ start: 0, end: 0 });
  // Carry the next caret position from a programmatic edit so we can apply it
  // imperatively after the body text has flushed. We avoid driving the
  // TextInput's `selection` prop because that would pin the caret on every
  // render and fight the user when they tap to move the cursor.
  const pendingSelectionRef = React.useRef<{ start: number; end: number } | null>(null);
  const [activeField, setActiveField] = React.useState<'to' | 'cc' | null>(null);
  const [attachments, setAttachments] = React.useState<AttachmentEntry[]>([]);
  const bodyInputRef = React.useRef<TextInput>(null);

  const allContacts = useContactsStore((s) => s.contacts);
  const individuals = React.useMemo(() => allContacts.filter((c) => !isGroup(c)), [allContacts]);

  const suggestionQuery = activeField === 'to' ? toInput : activeField === 'cc' ? ccInput : '';
  const alreadySelected = React.useMemo(
    () => new Set([...toRecipients, ...ccRecipients].map((r) => r.email.toLowerCase())),
    [toRecipients, ccRecipients],
  );
  const suggestions: Array<{ contact: ContactCard; name: string; email: string }> = React.useMemo(() => {
    const q = suggestionQuery.trim();
    if (q.length < 1) return [];
    const out: Array<{ contact: ContactCard; name: string; email: string }> = [];
    for (const c of individuals) {
      if (!matchesContactSearch(c, q)) continue;
      if (!c.emails) continue;
      const name = getContactDisplayName(c);
      for (const e of Object.values(c.emails)) {
        if (!e.address) continue;
        if (alreadySelected.has(e.address.toLowerCase())) continue;
        out.push({ contact: c, name, email: e.address });
        if (out.length >= 8) break;
      }
      if (out.length >= 8) break;
    }
    return out;
  }, [suggestionQuery, individuals, alreadySelected]);

  const pickSuggestion = (s: { name: string; email: string }) => {
    const recipient: Recipient = { name: s.name, email: s.email };
    if (activeField === 'cc') {
      setCcRecipients((prev) => [...prev, recipient]);
      setCcInput('');
    } else {
      setToRecipients((prev) => [...prev, recipient]);
      setToInput('');
    }
  };

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await getIdentities();
        if (!cancelled) setIdentities(list);
      } catch (e) {
        if (!cancelled) {
          setIdentityError(e instanceof Error ? e.message : 'Failed to load identities');
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const primaryIdentity = identities[0];

  const commitTyped = () => {
    const extraTo = parseRecipients(toInput);
    const extraCc = parseRecipients(ccInput);
    const finalTo = [...toRecipients, ...extraTo];
    const finalCc = [...ccRecipients, ...extraCc];
    return { finalTo, finalCc };
  };

  const addTyped = () => {
    const extraTo = parseRecipients(toInput);
    const extraCc = parseRecipients(ccInput);
    if (extraTo.length) {
      setToRecipients((prev) => [...prev, ...extraTo]);
      setToInput('');
    }
    if (extraCc.length) {
      setCcRecipients((prev) => [...prev, ...extraCc]);
      setCcInput('');
    }
  };

  const { finalTo, finalCc } = commitTyped();
  const hasUploadInFlight = attachments.some((a) => a.uploading);
  const hasUploadError = attachments.some((a) => !!a.error);
  const hasValidRecipients = finalTo.every((r) => EMAIL_RE.test(r.email)) && finalTo.length > 0;
  const canSend =
    !sending &&
    !hasUploadInFlight &&
    !hasUploadError &&
    hasValidRecipients &&
    subject.trim().length > 0 &&
    !!primaryIdentity &&
    !!sentMailbox;

  const onBodySelectionChange = (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    setBodySelection(e.nativeEvent.selection);
  };

  // Apply caret moves imperatively once the body text has flushed - using
  // setNativeProps means we don't render the TextInput as selection-controlled
  // and the user keeps free cursor control.
  React.useLayoutEffect(() => {
    const target = pendingSelectionRef.current;
    if (!target || !bodyInputRef.current) return;
    pendingSelectionRef.current = null;
    bodyInputRef.current.setNativeProps({ selection: target });
    setBodySelection(target);
  });

  const applyEdit = (edit: { text: string; selection: { start: number; end: number } }) => {
    pendingSelectionRef.current = edit.selection;
    setBody(edit.text);
  };

  const onClose = () => {
    if (body.trim() || subject.trim() || attachments.length > 0) {
      Alert.alert(
        t('email_composer.close_draft_title', 'Discard draft?'),
        t('email_composer.discard_draft_confirm', 'You have unsaved changes. Do you want to discard this draft?'),
        [
          { text: t('email_composer.cancel', 'Cancel'), style: 'cancel' },
          {
            text: t('email_composer.discard', 'Discard'),
            style: 'destructive',
            onPress: () => navigation.goBack(),
          },
        ],
      );
      return;
    }
    navigation.goBack();
  };

  const addAttachmentEntry = (entry: AttachmentEntry) => {
    setAttachments((prev) => [...prev, entry]);
  };

  const updateAttachment = (localId: string, patch: Partial<AttachmentEntry>) => {
    setAttachments((prev) => prev.map((a) => (a.localId === localId ? { ...a, ...patch } : a)));
  };

  const removeAttachment = (localId: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.localId === localId);
      // If an inline image is removed, also drop its markdown reference from
      // the body so the user doesn't ship a dangling cid: link.
      if (removed?.inline && removed.cid) {
        const ref = `![${removed.name}](cid:${removed.cid})`;
        if (body.includes(ref)) setBody((b) => b.replace(ref, '').replace(/\n{3,}/g, '\n\n'));
      }
      return prev.filter((a) => a.localId !== localId);
    });
  };

  const startUpload = async (asset: {
    name: string;
    type: string;
    size: number;
    uri: string;
    inline: boolean;
  }) => {
    const localId = genLocalId();
    const cid = asset.inline ? genCid() : undefined;
    const entry: AttachmentEntry = {
      localId,
      name: asset.name,
      type: asset.type,
      size: asset.size,
      uri: asset.uri,
      inline: asset.inline,
      cid,
      uploading: true,
    };
    addAttachmentEntry(entry);

    if (asset.inline && cid) {
      // Insert a markdown reference at the caret so the user can move it.
      const ref = `\n![${asset.name}](cid:${cid})\n`;
      const next = wrapSelection(body, bodySelection, ref, '', '');
      applyEdit(next);
    }

    try {
      const { blobId, size, type } = await uploadBlob(asset.uri, asset.type);
      updateAttachment(localId, {
        blobId,
        type: type || asset.type,
        size: size || asset.size,
        uploading: false,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Upload failed';
      updateAttachment(localId, { uploading: false, error: message });
      Alert.alert(
        t('email_composer.send_failed', 'Failed to send email'),
        t('email_composer.upload_failed', 'Failed to upload {filename}').replace('{filename}', asset.name),
      );
    }
  };

  const pickAttachment = async (inline: boolean) => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t('email_composer.attach', 'Attach'),
        'Photo library permission is required to attach images.',
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: inline ? ['images'] : ['images', 'videos'],
      allowsMultipleSelection: !inline,
      quality: 0.9,
      exif: false,
    });
    if (result.canceled) return;
    for (const asset of result.assets) {
      const fallbackName = asset.fileName
        || `${inline ? 'image' : 'attachment'}-${Date.now()}.${(asset.mimeType ?? 'image/jpeg').split('/')[1] ?? 'bin'}`;
      void startUpload({
        name: fallbackName,
        type: asset.mimeType ?? 'application/octet-stream',
        size: asset.fileSize ?? 0,
        uri: asset.uri,
        inline,
      });
    }
  };

  // ── Format toolbar handlers ────────────────────────────────────────────
  const formatBold = () => {
    applyEdit(wrapSelection(body, bodySelection, '**', '**', 'bold'));
    bodyInputRef.current?.focus();
  };
  const formatItalic = () => {
    applyEdit(wrapSelection(body, bodySelection, '_', '_', 'italic'));
    bodyInputRef.current?.focus();
  };
  const formatBullet = () => {
    applyEdit(toggleLinePrefix(body, bodySelection, '- '));
    bodyInputRef.current?.focus();
  };
  const formatNumbered = () => {
    applyEdit(toggleLinePrefix(body, bodySelection, '1. '));
    bodyInputRef.current?.focus();
  };
  const formatQuote = () => {
    applyEdit(toggleLinePrefix(body, bodySelection, '> '));
    bodyInputRef.current?.focus();
  };
  const insertLink = (url: string) => {
    const target = URL_RE.test(url) ? url : `https://${url}`;
    const start = Math.min(bodySelection.start, bodySelection.end);
    const end = Math.max(bodySelection.start, bodySelection.end);
    const selected = body.slice(start, end);
    const label = selected || target;
    const insertion = `[${label}](${target})`;
    const next = `${body.slice(0, start)}${insertion}${body.slice(end)}`;
    const cursor = start + insertion.length;
    applyEdit({ text: next, selection: { start: cursor, end: cursor } });
    bodyInputRef.current?.focus();
  };

  const formatLink = () => {
    if (Platform.OS === 'ios' && typeof Alert.prompt === 'function') {
      Alert.prompt(
        t('email_composer.add_link', 'Add link'),
        t('email_composer.link_url_prompt', 'Enter the URL'),
        (url) => { if (url) insertLink(url); },
        'plain-text',
        '',
        'url',
      );
      return;
    }
    // Android / web: insert an editable stub with the URL portion selected.
    const stub = '[link text](https://)';
    const start = Math.min(bodySelection.start, bodySelection.end);
    const end = Math.max(bodySelection.start, bodySelection.end);
    const next = `${body.slice(0, start)}${stub}${body.slice(end)}`;
    const urlStart = start + '[link text]('.length;
    const urlEnd = start + stub.length - 1;
    applyEdit({ text: next, selection: { start: urlStart, end: urlEnd } });
    bodyInputRef.current?.focus();
  };

  const onSend = async () => {
    if (!canSend || !primaryIdentity || !sentMailbox) return;
    setSending(true);
    try {
      const from: EmailAddress[] = [{ name: primaryIdentity.name, email: primaryIdentity.email }];

      const quote = replyTo?.body
        ? formatReplyQuote(replyTo.body, {
            senderName: replyTo.from.name || replyTo.from.email,
            date: new Date(),
          })
        : '';

      const sourceText = body + quote;
      const htmlBody = markdownToHtml(sourceText);

      // Plain text fallback: keep the user's source as-is. Strip our basic
      // markdown markers so receivers without HTML get clean text.
      const plainText = sourceText
        .replace(/!\[([^\]]*)\]\(cid:[^)]+\)/g, '[$1]')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/(^|[^*\w])_([^_\n]+)_(?=$|[^*\w])/g, '$1$2');

      const outgoing: OutgoingAttachment[] = attachments
        .filter((a) => a.blobId && !a.error)
        .map((a) => ({
          blobId: a.blobId!,
          type: a.type,
          name: a.name,
          size: a.size,
          disposition: a.inline ? 'inline' : 'attachment',
          cid: a.cid,
        }));

      await sendEmail(
        {
          from,
          to: finalTo.map((r) => ({ name: r.name || undefined, email: r.email })),
          cc: finalCc.length
            ? finalCc.map((r) => ({ name: r.name || undefined, email: r.email }))
            : undefined,
          subject,
          htmlBody,
          textBody: plainText,
          attachments: outgoing.length ? outgoing : undefined,
          inReplyTo: replyTo?.inReplyTo,
          references: replyTo?.references,
        },
        primaryIdentity.id,
        sentMailbox.id,
      );
      navigation.goBack();
    } catch (e) {
      Alert.alert(
        t('email_composer.send_failed', 'Send failed'),
        e instanceof Error ? e.message : 'Failed to send email',
      );
    } finally {
      setSending(false);
    }
  };

  const titleKey =
    mode === 'forward' ? 'email_composer.forward'
    : mode === 'replyAll' ? 'email_composer.reply_all'
    : replyTo ? 'email_composer.reply'
    : 'email_composer.new_message';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable onPress={onClose} style={styles.headerBtn}>
          <X size={22} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle}>
          {t(titleKey, mode === 'forward' ? 'Forward' : mode === 'replyAll' ? 'Reply All' : replyTo ? 'Reply' : 'New Message')}
        </Text>
        <View style={styles.headerRight}>
          <Pressable
            onPress={() => { void pickAttachment(false); }}
            style={styles.headerBtn}
            hitSlop={8}
          >
            <Paperclip size={20} color={c.text} />
          </Pressable>
          <Button
            variant="default"
            size="sm"
            onPress={() => { void onSend(); }}
            disabled={!canSend}
            icon={
              sending ? (
                <ActivityIndicator color={c.primaryForeground} size="small" />
              ) : (
                <Send
                  size={14}
                  color={canSend ? c.primaryForeground : c.textMuted}
                />
              )
            }
            style={!canSend ? styles.sendButtonDisabled : undefined}
          >
            {sending ? t('email_composer.sending', 'Sending...') : t('email_composer.send', 'Send')}
          </Button>
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled">
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>{t('email_composer.from', 'From')}</Text>
            <View style={styles.fieldContent}>
              <Text style={styles.fromText} numberOfLines={1}>
                {primaryIdentity?.email ?? (identityError ? 'identity unavailable' : 'Loading...')}
              </Text>
              <ChevronDown size={14} color={c.textMuted} />
            </View>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>{t('email_composer.to', 'To')}</Text>
            <View style={styles.recipientField}>
              {toRecipients.map((r, i) => (
                <RecipientChip
                  key={i}
                  recipient={r}
                  onRemove={() => setToRecipients((prev) => prev.filter((_, idx) => idx !== i))}
                />
              ))}
              <TextInput
                style={styles.recipientInput}
                placeholder={t('email_composer.to_placeholder', 'Recipient email addresses')}
                placeholderTextColor={c.textMuted}
                value={toInput}
                onChangeText={setToInput}
                onFocus={() => setActiveField('to')}
                onBlur={() => {
                  addTyped();
                  setTimeout(() => setActiveField((f) => (f === 'to' ? null : f)), 200);
                }}
                onSubmitEditing={addTyped}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            {activeField === 'to' && suggestions.length > 0 && (
              <SuggestionList suggestions={suggestions} onPick={pickSuggestion} />
            )}
            {!ccVisible && (
              <Pressable onPress={() => setCcVisible(true)} style={styles.ccToggle}>
                <Text style={styles.ccToggleText}>{t('email_composer.cc', 'Cc')}</Text>
              </Pressable>
            )}
          </View>

          {ccVisible && (
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>{t('email_composer.cc', 'Cc')}</Text>
              <View style={styles.recipientField}>
                {ccRecipients.map((r, i) => (
                  <RecipientChip
                    key={i}
                    recipient={r}
                    onRemove={() => setCcRecipients((prev) => prev.filter((_, idx) => idx !== i))}
                  />
                ))}
                <TextInput
                  style={styles.recipientInput}
                  placeholder={t('email_composer.cc_placeholder', 'Cc recipients')}
                  placeholderTextColor={c.textMuted}
                  value={ccInput}
                  onChangeText={setCcInput}
                  onFocus={() => setActiveField('cc')}
                  onBlur={() => {
                    addTyped();
                    setTimeout(() => setActiveField((f) => (f === 'cc' ? null : f)), 200);
                  }}
                  onSubmitEditing={addTyped}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              {activeField === 'cc' && suggestions.length > 0 && (
                <SuggestionList suggestions={suggestions} onPick={pickSuggestion} />
              )}
            </View>
          )}

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>{t('email_composer.subject', 'Subject')}</Text>
            <TextInput
              style={styles.subjectInput}
              placeholder={t('email_composer.subject_placeholder', 'Subject')}
              placeholderTextColor={c.textMuted}
              value={subject}
              onChangeText={setSubject}
            />
          </View>

          {attachments.length > 0 && (
            <View style={styles.attachmentList}>
              {attachments.map((a) => (
                <AttachmentChip
                  key={a.localId}
                  attachment={a}
                  onRemove={() => removeAttachment(a.localId)}
                />
              ))}
            </View>
          )}

          <TextInput
            ref={bodyInputRef}
            style={styles.bodyInput}
            placeholder={t('email_composer.body_placeholder', 'Write your message...')}
            placeholderTextColor={c.textMuted}
            value={body}
            onChangeText={setBody}
            onSelectionChange={onBodySelectionChange}
            multiline
            textAlignVertical="top"
            autoCapitalize="sentences"
          />

          {replyTo?.body && (
            <View style={styles.quoteBlock}>
              <View style={styles.quoteBorder} />
              <View style={styles.quoteContent}>
                <Text style={styles.quoteMeta}>
                  {t('email_composer.quote.reply_header', 'On {date}, {sender} wrote:')
                    .replace('{date}', new Date().toLocaleDateString())
                    .replace('{sender}', replyTo.from.name || replyTo.from.email)}
                </Text>
                <Text style={styles.quoteText} numberOfLines={6}>
                  {replyTo.body}
                </Text>
              </View>
            </View>
          )}
        </ScrollView>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.formatBar}
          contentContainerStyle={styles.formatActions}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable style={styles.formatBtn} onPress={formatBold} hitSlop={4}>
            <Bold size={18} color={c.textSecondary} />
          </Pressable>
          <Pressable style={styles.formatBtn} onPress={formatItalic} hitSlop={4}>
            <Italic size={18} color={c.textSecondary} />
          </Pressable>
          <View style={styles.formatSep} />
          <Pressable style={styles.formatBtn} onPress={formatBullet} hitSlop={4}>
            <List size={18} color={c.textSecondary} />
          </Pressable>
          <Pressable style={styles.formatBtn} onPress={formatNumbered} hitSlop={4}>
            <ListOrdered size={18} color={c.textSecondary} />
          </Pressable>
          <Pressable style={styles.formatBtn} onPress={formatQuote} hitSlop={4}>
            <Quote size={18} color={c.textSecondary} />
          </Pressable>
          <View style={styles.formatSep} />
          <Pressable style={styles.formatBtn} onPress={formatLink} hitSlop={4}>
            <Link2 size={18} color={c.textSecondary} />
          </Pressable>
          <Pressable
            style={styles.formatBtn}
            onPress={() => { void pickAttachment(true); }}
            hitSlop={4}
          >
            <ImageIcon size={18} color={c.textSecondary} />
          </Pressable>
          <Pressable
            style={styles.formatBtn}
            onPress={() => { void pickAttachment(false); }}
            hitSlop={4}
          >
            <Paperclip size={18} color={c.textSecondary} />
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  flex: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    gap: spacing.sm,
  },
  headerBtn: {
    width: componentSizes.buttonLg,
    height: componentSizes.buttonLg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  headerTitle: { ...typography.h3, color: c.text, flex: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sendButtonDisabled: { opacity: 0.5 },

  fieldRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
    gap: spacing.md,
  },
  fieldLabel: {
    ...typography.body,
    color: c.textMuted,
    width: 56,
    paddingTop: 10,
  },
  fieldContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: spacing.sm,
  },
  fromText: { ...typography.body, color: c.text },
  recipientField: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 4,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: c.surfaceActive,
    maxWidth: 220,
  },
  chipText: { ...typography.caption, color: c.text, flexShrink: 1 },
  recipientInput: {
    flexGrow: 1,
    minWidth: 100,
    ...typography.body,
    color: c.text,
    paddingVertical: 6,
  },
  suggestionBox: {
    marginTop: spacing.xs,
    marginLeft: 60,
    borderWidth: 1,
    borderColor: c.borderLight,
    borderRadius: radius.sm,
    backgroundColor: c.card,
    overflow: 'hidden',
  },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  suggestionRowPressed: { backgroundColor: c.surfaceHover },
  suggestionAvatar: {
    width: 32, height: 32,
    borderRadius: 16,
    backgroundColor: c.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestionAvatarText: { ...typography.captionMedium, color: c.primary },
  suggestionText: { flex: 1 },
  suggestionName: { ...typography.bodyMedium, color: c.text },
  suggestionEmail: { ...typography.caption, color: c.textSecondary },
  ccToggle: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  ccToggleText: { ...typography.caption, color: c.primary },
  subjectInput: {
    flex: 1,
    ...typography.body,
    color: c.text,
    paddingVertical: 10,
  },

  attachmentList: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
  },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: c.surfaceActive,
  },
  attachmentMeta: { flex: 1, minWidth: 0 },
  attachmentName: { ...typography.bodyMedium, color: c.text },
  attachmentSize: { ...typography.caption, color: c.textMuted },
  attachmentRemove: { padding: 4 },

  bodyInput: {
    ...typography.body,
    color: c.text,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 200,
    lineHeight: 22,
  },

  quoteBlock: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  quoteBorder: { width: 3, backgroundColor: c.border, borderRadius: radius.xs },
  quoteContent: { flex: 1 },
  quoteMeta: { ...typography.caption, color: c.textMuted, marginBottom: spacing.xs },
  quoteText: { ...typography.caption, color: c.textSecondary, lineHeight: 18 },

  formatBar: {
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.surface,
    flexGrow: 0,
  },
  formatActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  formatBtn: {
    width: componentSizes.buttonMd,
    height: componentSizes.buttonMd,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  formatSep: {
    width: 1,
    height: 20,
    backgroundColor: c.borderLight,
    marginHorizontal: 2,
  },
  });
}
