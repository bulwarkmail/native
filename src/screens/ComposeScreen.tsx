import React from 'react';
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  Keyboard, Dimensions, Platform, ActivityIndicator, Alert, Modal,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  X, Send, Paperclip, ChevronDown, Bold, Italic, Underline, Strikethrough,
  List, ListOrdered, Link2, Link2Off, Image as ImageIcon, Quote,
  Heading1, Heading2, AlignLeft, AlignCenter, AlignRight, RemoveFormatting,
  Undo2, Redo2, FileText, Clock, Check,
} from 'lucide-react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { File as FsFile } from 'expo-file-system';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { Button, IdentitySheet } from '../components';
import RichTextEditor, {
  type RichTextEditorHandle,
  type RichTextSelectionState,
} from '../components/RichTextEditor';
import { useEmailStore } from '../stores/email-store';
import { useContactsStore } from '../stores/contacts-store';
import { useLocaleStore } from '../stores/locale-store';
import { useSettingsStore } from '../stores/settings-store';
import { useAccountStore } from '../stores/account-store';
import { isGroup } from '../lib/contact-utils';
import {
  getContactDisplayName,
  getContactInitials,
  matchesContactSearch,
} from '../lib/contact-utils';
import { getIdentities } from '../api/identity';
import { sendEmail, type OutgoingAttachment } from '../api/email';
import { jmapClient } from '../api/jmap-client';
import { uploadBlob } from '../api/blob';
import { buildInitialHtml, htmlToPlainText, rewriteInlineImages } from '../lib/compose-html';
import { stripDangerousTags } from '../lib/email-html';
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

async function readUriAsDataUrl(uri: string, mime: string): Promise<string | null> {
  try {
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return `data:${mime};base64,${base64}`;
  } catch {
    return null;
  }
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

function ToolbarButton({
  active, onPress, icon, disabled,
}: {
  active?: boolean;
  onPress: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      disabled={disabled}
      style={[styles.formatBtn, active && styles.formatBtnActive, disabled && styles.formatBtnDisabled]}
    >
      {icon}
    </Pressable>
  );
}

export default function ComposeScreen({ route, navigation }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const insets = useSafeAreaInsets();
  // Track the visible keyboard obstruction so the format bar stays above it.
  // On Android edge-to-edge, the IME-inset reported by `keyboardDidShow` is
  // measured from the top of the gesture-nav bar rather than from the true
  // screen bottom, so we derive obstruction height from `Dimensions.screen`
  // instead of trusting `endCoordinates.height` directly. The same trick
  // works on iOS for the QuickType / autofill / dictation strip.
  const [kbObstruction, setKbObstruction] = React.useState(0);
  React.useEffect(() => {
    const recompute = (endY: number) => {
      const screenH = Dimensions.get('screen').height;
      setKbObstruction(Math.max(0, screenH - endY));
    };
    const subs =
      Platform.OS === 'ios'
        ? [
            Keyboard.addListener('keyboardWillChangeFrame', (e) => {
              recompute(e.endCoordinates?.screenY ?? Number.MAX_SAFE_INTEGER);
            }),
          ]
        : [
            Keyboard.addListener('keyboardDidShow', (e) => {
              recompute(e.endCoordinates?.screenY ?? Number.MAX_SAFE_INTEGER);
            }),
            Keyboard.addListener('keyboardDidHide', () => setKbObstruction(0)),
          ];
    return () => {
      for (const s of subs) s.remove();
    };
  }, []);
  // When the keyboard is up it covers the bottom safe area, so we don't
  // need to add it on top — pad by whichever is larger.
  const bottomPad = Math.max(kbObstruction, insets.bottom);
  const replyTo = route.params?.replyTo;
  const mode = route.params?.mode ?? 'compose';
  const prefillTo = route.params?.prefillTo;
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const sentMailbox = React.useMemo(
    () => mailboxes.find((m) => m.role === 'sent'),
    [mailboxes],
  );

  const [identities, setIdentities] = React.useState<Identity[]>([]);
  const [identityError, setIdentityError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [selectedIdentityId, setSelectedIdentityId] = React.useState<string | null>(null);
  const [identitySheetOpen, setIdentitySheetOpen] = React.useState(false);
  const [scheduleSheetOpen, setScheduleSheetOpen] = React.useState(false);
  // Custom date/time picker stage. iOS shows one 'datetime' spinner; Android
  // can only show one field at a time, so we walk date → time.
  const [customStage, setCustomStage] = React.useState<'datetime' | 'date' | 'time' | null>(null);
  const customDraftRef = React.useRef<Date>(new Date());

  const autoSelectReplyIdentity = useSettingsStore((s) => s.autoSelectReplyIdentity);
  const plainTextMode = useSettingsStore((s) => s.plainTextMode);
  const attachmentReminderEnabled = useSettingsStore((s) => s.attachmentReminderEnabled);
  const attachmentReminderKeywords = useSettingsStore((s) => s.attachmentReminderKeywords);
  const sendDelaySeconds = useSettingsStore((s) => s.sendDelaySeconds);

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

  const initialBodyHtml = React.useMemo(
    () => buildInitialHtml(mode, replyTo
      ? {
          from: { name: replyTo.from.name, email: replyTo.from.email },
          to: replyTo.to,
          cc: replyTo.cc,
          subject: replyTo.subject,
          body: replyTo.body,
          receivedAt: replyTo.receivedAt,
        }
      : null,
      { timeFormat, locale, unknownLabel: t('common.unknown', 'Unknown') },
    ),
    [mode, replyTo, timeFormat, locale, t],
  );

  const [toRecipients, setToRecipients] = React.useState<Recipient[]>(initialTo);
  const [ccRecipients, setCcRecipients] = React.useState<Recipient[]>(initialCc);
  const [ccVisible, setCcVisible] = React.useState(initialCc.length > 0);
  const [toInput, setToInput] = React.useState('');
  const [ccInput, setCcInput] = React.useState('');
  const [subject, setSubject] = React.useState(initialSubject);
  const [bodyHtml, setBodyHtml] = React.useState(initialBodyHtml);
  const [activeField, setActiveField] = React.useState<'to' | 'cc' | null>(null);
  const [attachments, setAttachments] = React.useState<AttachmentEntry[]>([]);
  const [selState, setSelState] = React.useState<RichTextSelectionState>({
    bold: false, italic: false, underline: false, strikeThrough: false,
    ul: false, ol: false, blockquote: false, h1: false, h2: false,
    alignLeft: false, alignCenter: false, alignRight: false, link: false,
  });

  const editorRef = React.useRef<RichTextEditorHandle>(null);
  // Track inline-image placeholders that haven't yet been rewritten to cid:
  // until send time. Maps cid → blobId/type/name/size.
  const inlineRegistryRef = React.useRef<Map<string, AttachmentEntry>>(new Map());

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

  // Choose the identity once we know both the loaded identities and the reply
  // context. With auto-select on, prefer the identity that received the
  // original message (matches webmail's reply-identity behaviour).
  React.useEffect(() => {
    if (selectedIdentityId || identities.length === 0) return;
    const activeEmail = useAccountStore.getState().getActiveAccount()?.email || jmapClient.username;
    const defaultIdentity = identities.find(
      (i) => i.email.toLowerCase() === activeEmail?.toLowerCase()
    ) ?? identities[0];

    if (autoSelectReplyIdentity && replyTo) {
      const candidates = [...(replyTo.to ?? []), ...(replyTo.cc ?? [])];
      const candidateAddrs = new Set(
        candidates.map((r) => r.email?.toLowerCase()).filter(Boolean) as string[],
      );
      const matched = identities.find((i) => candidateAddrs.has(i.email.toLowerCase()));
      setSelectedIdentityId((matched ?? defaultIdentity).id);
    } else {
      setSelectedIdentityId(defaultIdentity.id);
    }
  }, [identities, autoSelectReplyIdentity, replyTo, selectedIdentityId]);

  const primaryIdentity = React.useMemo(() => {
    if (identities.length === 0) return null;
    const activeEmail = useAccountStore.getState().getActiveAccount()?.email || jmapClient.username;
    const defaultIdentity = identities.find(
      (i) => i.email.toLowerCase() === activeEmail?.toLowerCase()
    ) ?? identities[0];
    return identities.find((i) => i.id === selectedIdentityId) ?? defaultIdentity;
  }, [identities, selectedIdentityId]);

  const openIdentityPicker = () => {
    if (identities.length <= 1) return;
    setIdentitySheetOpen(true);
  };

  const commitTyped = () => {
    const extraTo = parseRecipients(toInput);
    const extraCc = parseRecipients(ccInput);
    return {
      finalTo: [...toRecipients, ...extraTo],
      finalCc: [...ccRecipients, ...extraCc],
    };
  };

  const addTyped = () => {
    const extraTo = parseRecipients(toInput);
    const extraCc = parseRecipients(ccInput);
    if (extraTo.length) {
      setToRecipients((prev) => {
        const existing = new Set(prev.map((r) => r.email.toLowerCase()));
        const unique: Recipient[] = [];
        for (const r of extraTo) {
          const emailLower = r.email.toLowerCase();
          if (!existing.has(emailLower)) {
            existing.add(emailLower);
            unique.push(r);
          }
        }
        return [...prev, ...unique];
      });
      setToInput('');
    }
    if (extraCc.length) {
      setCcRecipients((prev) => {
        const existing = new Set(prev.map((r) => r.email.toLowerCase()));
        const unique: Recipient[] = [];
        for (const r of extraCc) {
          const emailLower = r.email.toLowerCase();
          if (!existing.has(emailLower)) {
            existing.add(emailLower);
            unique.push(r);
          }
        }
        return [...prev, ...unique];
      });
      setCcInput('');
    }
  };

  const { finalTo, finalCc } = commitTyped();
  const hasUploadInFlight = attachments.some((a) => a.uploading);
  const hasUploadError = attachments.some((a) => !!a.error);
  const hasValidRecipients = finalTo.every((r) => EMAIL_RE.test(r.email)) && finalTo.length > 0;
  const bodyPlain = React.useMemo(() => htmlToPlainText(bodyHtml), [bodyHtml]);
  const hasBodyContent = bodyPlain.trim().length > 0
    || attachments.some((a) => a.blobId && !a.error);
  const canSend =
    !sending &&
    !hasUploadInFlight &&
    !hasUploadError &&
    hasValidRecipients &&
    subject.trim().length > 0 &&
    hasBodyContent &&
    !!primaryIdentity &&
    !!sentMailbox;

  const onClose = () => {
    const isDirty =
      bodyPlain.trim().length > 0
      || subject.trim().length > 0
      || toRecipients.length > 0
      || ccRecipients.length > 0
      || attachments.length > 0;
    if (isDirty) {
      Alert.alert(
        t('email_composer.discard_draft_title', 'Discard draft?'),
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

  // ── Attachments ──────────────────────────────────────────────────────
  const updateAttachment = (localId: string, patch: Partial<AttachmentEntry>) => {
    setAttachments((prev) => prev.map((a) => (a.localId === localId ? { ...a, ...patch } : a)));
    if (patch.blobId !== undefined || patch.error !== undefined) {
      const cid = inlineRegistryRef.current;
      const entry = Array.from(cid.values()).find((e) => e.localId === localId);
      if (entry) cid.set(entry.cid!, { ...entry, ...patch });
    }
  };

  const removeAttachment = (localId: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.localId === localId);
      if (removed?.inline && removed.cid) {
        inlineRegistryRef.current.delete(removed.cid);
        // Strip the editor's <img data-cid="…"> for this cid.
        const escCid = removed.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const stripped = bodyHtml.replace(
          new RegExp(`<img\\b[^>]*\\sdata-cid=("${escCid}"|'${escCid}')[^>]*>`, 'gi'),
          '',
        );
        if (stripped !== bodyHtml) {
          setBodyHtml(stripped);
          editorRef.current?.setHtml(stripped);
        }
      }
      return prev.filter((a) => a.localId !== localId);
    });
  };

  const addUploadEntry = (asset: {
    name: string;
    type: string;
    size: number;
    uri: string;
    inline: boolean;
    cid?: string;
  }): AttachmentEntry => {
    const localId = genLocalId();
    const entry: AttachmentEntry = {
      localId,
      name: asset.name,
      type: asset.type,
      size: asset.size,
      uri: asset.uri,
      inline: asset.inline,
      cid: asset.cid,
      uploading: true,
    };
    setAttachments((prev) => [...prev, entry]);
    if (asset.inline && asset.cid) inlineRegistryRef.current.set(asset.cid, entry);
    return entry;
  };

  const startUpload = async (entry: AttachmentEntry) => {
    try {
      const { blobId, size, type } = await uploadBlob(entry.uri, entry.type);
      updateAttachment(entry.localId, {
        blobId,
        type: type || entry.type,
        size: size || entry.size,
        uploading: false,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Upload failed';
      updateAttachment(entry.localId, { uploading: false, error: message });
      Alert.alert(
        t('email_composer.upload_failed', 'Failed to upload {filename}').replace('{filename}', entry.name),
        message,
      );
    }
  };

  const pickPhotoAttachments = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t('email_composer.attach', 'Attach'),
        'Photo library permission is required to attach images.',
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      quality: 0.9,
      exif: false,
    });
    if (result.canceled) return;
    for (const asset of result.assets) {
      const fallbackName = asset.fileName
        || `attachment-${Date.now()}.${(asset.mimeType ?? 'application/octet-stream').split('/')[1] ?? 'bin'}`;
      const entry = addUploadEntry({
        name: fallbackName,
        type: asset.mimeType ?? 'application/octet-stream',
        size: asset.fileSize ?? 0,
        uri: asset.uri,
        inline: false,
      });
      void startUpload(entry);
    }
  };

  const pickFileAttachment = async () => {
    // pickFileAsync's return type is the lower-level FileSystemFile, not the
    // public `File` wrapper. Both expose the fields we need (uri/name/size/type).
    type PickedFile = { uri: string; name?: string; size?: number; type?: string };
    let picked: PickedFile | undefined;
    try {
      const result = await FsFile.pickFileAsync();
      picked = (Array.isArray(result) ? result[0] : result) as PickedFile;
    } catch (e) {
      // The picker rejects with PickerCancelledException when the user backs
      // out — treat that as a no-op rather than surfacing an error.
      const message = e instanceof Error ? e.message : String(e);
      if (/cancel/i.test(message)) return;
      Alert.alert(t('email_composer.attach', 'Attach'), message);
      return;
    }
    if (!picked) return;
    const type = picked.type || 'application/octet-stream';
    const name = picked.name || `attachment-${Date.now()}`;
    const entry = addUploadEntry({
      name,
      type,
      size: picked.size ?? 0,
      uri: picked.uri,
      inline: false,
    });
    void startUpload(entry);
  };

  const pickAttachment = () => {
    Alert.alert(
      t('email_composer.attach', 'Attach'),
      undefined,
      [
        {
          text: t('email_composer.attach_photos', 'Photos & Videos'),
          onPress: () => { void pickPhotoAttachments(); },
        },
        {
          text: t('email_composer.attach_files', 'Files'),
          onPress: () => { void pickFileAttachment(); },
        },
        { text: t('email_composer.cancel', 'Cancel'), style: 'cancel' },
      ],
    );
  };

  const insertInlineImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t('email_composer.attach', 'Attach'),
        'Photo library permission is required to attach images.',
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 0.9,
      exif: false,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const mime = asset.mimeType ?? 'image/jpeg';
    const fallbackName = asset.fileName || `image-${Date.now()}.${mime.split('/')[1] ?? 'jpg'}`;
    const cid = genCid();

    // Read the picked image as a data URL so it shows up immediately in the
    // editor. At send time the data URL is rewritten to `cid:<id>` and the
    // matching inline part is added via the registry.
    const dataUrl = await readUriAsDataUrl(asset.uri, mime);
    if (!dataUrl) {
      Alert.alert(t('email_composer.attach', 'Attach'), 'Could not load image');
      return;
    }
    editorRef.current?.insertImage(dataUrl, cid, fallbackName);
    const entry = addUploadEntry({
      name: fallbackName,
      type: mime,
      size: asset.fileSize ?? 0,
      uri: asset.uri,
      inline: true,
      cid,
    });
    void startUpload(entry);
  };

  // ── Link prompt (Modal) ──────────────────────────────────────────────
  const [linkPromptVisible, setLinkPromptVisible] = React.useState(false);
  const [linkPromptValue, setLinkPromptValue] = React.useState('');

  const openLinkPrompt = () => {
    setLinkPromptValue('https://');
    setLinkPromptVisible(true);
  };

  const submitLinkPrompt = () => {
    const trimmed = linkPromptValue.trim();
    setLinkPromptVisible(false);
    if (!trimmed || trimmed === 'https://' || trimmed === 'http://') return;
    const url = URL_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
    editorRef.current?.insertLink(url);
  };

  const onLinkPress = () => {
    if (selState.link) {
      editorRef.current?.unsetLink();
      return;
    }
    openLinkPrompt();
  };

  // ── Send ─────────────────────────────────────────────────────────────

  // Catch the classic "I forgot the attachment" footgun. Only file attachments
  // count - inline images don't satisfy the user's intent of attaching a file.
  // Returns true if it's safe to proceed, false if the user cancelled.
  const passesAttachmentReminder = async (): Promise<boolean> => {
    if (!attachmentReminderEnabled) return true;
    const hasFileAttachment = attachments.some(
      (a) => !a.inline && a.blobId && !a.error,
    );
    if (hasFileAttachment) return true;
    const haystack = `${subject}\n${htmlToPlainText(bodyHtml)}`.toLowerCase();
    const matchedKeyword = attachmentReminderKeywords.find((kw) => {
      const k = kw.trim().toLowerCase();
      if (!k) return false;
      // Word-boundary match so 'attach' doesn't fire on 'detached'.
      return new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack);
    });
    if (!matchedKeyword) return true;
    return new Promise<boolean>((resolve) => {
      Alert.alert(
        t('email_composer.attachment_reminder_title', 'Forgot an attachment?'),
        t(
          'email_composer.attachment_reminder_body',
          'Your message mentions "{keyword}" but no file is attached. Send anyway?',
        ).replace('{keyword}', matchedKeyword),
        [
          { text: t('email_composer.cancel', 'Cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: t('email_composer.send', 'Send'), onPress: () => resolve(true) },
        ],
      );
    });
  };

  // Translate an absolute "send at" time into the HOLDFOR seconds the server
  // expects, clamping to what it actually supports. Returns null (and alerts)
  // when scheduling isn't possible so the caller can abort.
  const resolveHoldForScheduledAt = (date: Date): number | null => {
    const seconds = Math.ceil((date.getTime() - Date.now()) / 1000);
    if (seconds <= 0) {
      Alert.alert(
        t('email_composer.schedule_past_title', 'Pick a future time'),
        t('email_composer.schedule_past_body', 'The scheduled time must be in the future.'),
      );
      return null;
    }
    if (!jmapClient.hasDelayedSend()) {
      Alert.alert(
        t('email_composer.schedule_unsupported_title', 'Scheduling unavailable'),
        t('email_composer.schedule_unsupported_body', 'This mail server does not support scheduled send.'),
      );
      return null;
    }
    const max = jmapClient.getMaxDelayedSend();
    if (max > 0 && seconds > max) {
      Alert.alert(
        t('email_composer.schedule_too_late_title', 'Too far ahead'),
        t('email_composer.schedule_too_late_body', 'That is later than this server allows. Pick an earlier time.'),
      );
      return null;
    }
    return seconds;
  };

  // The Send button: applies the global undo-send delay when the server
  // supports it, otherwise sends immediately.
  const onSend = () => {
    const holdFor = sendDelaySeconds > 0 && jmapClient.hasDelayedSend() ? sendDelaySeconds : undefined;
    void performSend(holdFor);
  };

  const onScheduleConfirm = (date: Date) => {
    const holdFor = resolveHoldForScheduledAt(date);
    if (holdFor == null) return;
    setScheduleSheetOpen(false);
    void performSend(holdFor, date);
  };

  const schedulePresets = React.useMemo(() => {
    const now = new Date();
    const inHours = (h: number) => new Date(now.getTime() + h * 3600 * 1000);
    const tomorrowMorning = new Date(now);
    tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
    tomorrowMorning.setHours(8, 0, 0, 0);
    return [
      { label: t('email_composer.schedule_in_1h', 'In 1 hour'), date: inHours(1) },
      { label: t('email_composer.schedule_in_3h', 'In 3 hours'), date: inHours(3) },
      { label: t('email_composer.schedule_tomorrow', 'Tomorrow, 8:00 AM'), date: tomorrowMorning },
    ];
  }, [t, scheduleSheetOpen]);

  const startCustomPicker = () => {
    customDraftRef.current = new Date(Date.now() + 3600 * 1000);
    setScheduleSheetOpen(false);
    setCustomStage(Platform.OS === 'ios' ? 'datetime' : 'date');
  };

  const onCustomPickerChange = (event: DateTimePickerEvent, selected?: Date) => {
    if (event.type === 'dismissed' || !selected) {
      setCustomStage(null);
      return;
    }
    if (Platform.OS === 'ios') {
      // Single spinner — keep it open, just remember the latest value.
      customDraftRef.current = selected;
      return;
    }
    // Android: combine the date step with the existing time, then ask for time.
    if (customStage === 'date') {
      const d = new Date(customDraftRef.current);
      d.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
      customDraftRef.current = d;
      setCustomStage('time');
      return;
    }
    if (customStage === 'time') {
      const d = new Date(customDraftRef.current);
      d.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
      setCustomStage(null);
      onScheduleConfirm(d);
    }
  };

  const performSend = async (holdForSeconds?: number, scheduledAt?: Date) => {
    if (!canSend || !primaryIdentity || !sentMailbox) return;
    if (!(await passesAttachmentReminder())) return;
    setSending(true);
    try {
      const from: EmailAddress[] = [{ name: primaryIdentity.name, email: primaryIdentity.email }];

      const { html: rewrittenHtml, usedCids } = rewriteInlineImages(bodyHtml);
      // Belt-and-suspenders sanitization: the editor uses execCommand which
      // can preserve pasted <script>/<style>/etc. Strip them before sending.
      const safeHtml = stripDangerousTags(rewrittenHtml);
      const finalHtml = `<div>${safeHtml}</div>`;
      const finalText = htmlToPlainText(safeHtml);

      const inlineFromBody = usedCids
        .map((cid) => inlineRegistryRef.current.get(cid))
        .filter((e): e is AttachmentEntry => !!e && !!e.blobId && !e.error)
        .map<OutgoingAttachment>((e) => ({
          blobId: e.blobId!,
          type: e.type,
          name: e.name,
          size: e.size,
          disposition: 'inline',
          cid: e.cid,
        }));

      const fileAttachments = attachments
        .filter((a) => !a.inline && a.blobId && !a.error)
        .map<OutgoingAttachment>((a) => ({
          blobId: a.blobId!,
          type: a.type,
          name: a.name,
          size: a.size,
          disposition: 'attachment',
        }));

      const outgoing = [...inlineFromBody, ...fileAttachments];

      const result = await sendEmail(
        {
          from,
          to: finalTo.map((r) => ({ name: r.name || undefined, email: r.email })),
          cc: finalCc.length
            ? finalCc.map((r) => ({ name: r.name || undefined, email: r.email }))
            : undefined,
          subject,
          // Plain-text mode: skip the HTML part entirely so receiving clients
          // render the text/plain alternative without any formatting.
          htmlBody: plainTextMode ? undefined : finalHtml,
          textBody: finalText,
          attachments: outgoing.length ? outgoing : undefined,
          inReplyTo: replyTo?.inReplyTo,
          references: replyTo?.references,
        },
        primaryIdentity.id,
        sentMailbox.id,
        holdForSeconds,
      );
      // Confirm an explicit "send later" so the user knows it didn't go out
      // now. The brief undo-send delay stays silent — it's meant to be
      // invisible unless the user cancels from the Scheduled view.
      if (scheduledAt && result.scheduled) {
        const when = result.sendAt ? new Date(result.sendAt) : scheduledAt;
        Alert.alert(
          t('email_composer.scheduled_title', 'Scheduled'),
          t('email_composer.scheduled_body', 'Your message will be sent at {time}.').replace(
            '{time}',
            when.toLocaleString(),
          ),
        );
      }
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
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={onClose} style={styles.headerBtn}>
          <X size={22} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle}>
          {t(titleKey, mode === 'forward' ? 'Forward' : mode === 'replyAll' ? 'Reply All' : replyTo ? 'Reply' : 'New Message')}
        </Text>
        <View style={styles.headerRight}>
          <Pressable
            onPress={() => { void pickAttachment(); }}
            style={styles.headerBtn}
            hitSlop={8}
          >
            <Paperclip size={20} color={c.text} />
          </Pressable>
          <Pressable
            onPress={() => setScheduleSheetOpen(true)}
            style={styles.headerBtn}
            hitSlop={8}
            disabled={!canSend}
          >
            <Clock size={20} color={canSend ? c.text : c.textMuted} />
          </Pressable>
          <Button
            variant="default"
            size="sm"
            onPress={onSend}
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

      <View style={[styles.flex, { paddingBottom: bottomPad }]}>
        <ScrollView
          style={styles.flex}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollContent}
        >
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>{t('email_composer.from', 'From')}</Text>
            <Pressable
              onPress={openIdentityPicker}
              disabled={identities.length <= 1}
              style={styles.fieldContent}
            >
              <Text style={styles.fromText} numberOfLines={1}>
                {primaryIdentity?.email ?? (identityError ? 'identity unavailable' : 'Loading...')}
              </Text>
              <ChevronDown size={14} color={c.textMuted} />
            </Pressable>
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

          <RichTextEditor
            ref={editorRef}
            initialHtml={initialBodyHtml}
            placeholder={t('email_composer.body_placeholder', 'Write your message...')}
            onChange={setBodyHtml}
            onSelectionChange={setSelState}
          />
        </ScrollView>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.formatBar}
          contentContainerStyle={styles.formatActions}
          keyboardShouldPersistTaps="always"
        >
          <ToolbarButton active={selState.bold} onPress={() => editorRef.current?.exec('bold')}
            icon={<Bold size={18} color={selState.bold ? c.primary : c.textSecondary} />} />
          <ToolbarButton active={selState.italic} onPress={() => editorRef.current?.exec('italic')}
            icon={<Italic size={18} color={selState.italic ? c.primary : c.textSecondary} />} />
          <ToolbarButton active={selState.underline} onPress={() => editorRef.current?.exec('underline')}
            icon={<Underline size={18} color={selState.underline ? c.primary : c.textSecondary} />} />
          <ToolbarButton active={selState.strikeThrough} onPress={() => editorRef.current?.exec('strikeThrough')}
            icon={<Strikethrough size={18} color={selState.strikeThrough ? c.primary : c.textSecondary} />} />

          <View style={styles.formatSep} />

          <ToolbarButton active={selState.h1} onPress={() => editorRef.current?.exec('formatBlock:H1')}
            icon={<Heading1 size={18} color={selState.h1 ? c.primary : c.textSecondary} />} />
          <ToolbarButton active={selState.h2} onPress={() => editorRef.current?.exec('formatBlock:H2')}
            icon={<Heading2 size={18} color={selState.h2 ? c.primary : c.textSecondary} />} />

          <View style={styles.formatSep} />

          <ToolbarButton active={selState.ul} onPress={() => editorRef.current?.exec('insertUnorderedList')}
            icon={<List size={18} color={selState.ul ? c.primary : c.textSecondary} />} />
          <ToolbarButton active={selState.ol} onPress={() => editorRef.current?.exec('insertOrderedList')}
            icon={<ListOrdered size={18} color={selState.ol ? c.primary : c.textSecondary} />} />
          <ToolbarButton active={selState.blockquote} onPress={() => editorRef.current?.exec('formatBlock:BLOCKQUOTE')}
            icon={<Quote size={18} color={selState.blockquote ? c.primary : c.textSecondary} />} />

          <View style={styles.formatSep} />

          <ToolbarButton active={selState.alignLeft} onPress={() => editorRef.current?.exec('justifyLeft')}
            icon={<AlignLeft size={18} color={selState.alignLeft ? c.primary : c.textSecondary} />} />
          <ToolbarButton active={selState.alignCenter} onPress={() => editorRef.current?.exec('justifyCenter')}
            icon={<AlignCenter size={18} color={selState.alignCenter ? c.primary : c.textSecondary} />} />
          <ToolbarButton active={selState.alignRight} onPress={() => editorRef.current?.exec('justifyRight')}
            icon={<AlignRight size={18} color={selState.alignRight ? c.primary : c.textSecondary} />} />

          <View style={styles.formatSep} />

          <ToolbarButton active={selState.link} onPress={onLinkPress}
            icon={selState.link
              ? <Link2Off size={18} color={c.primary} />
              : <Link2 size={18} color={c.textSecondary} />} />
          <ToolbarButton onPress={() => { void insertInlineImage(); }}
            icon={<ImageIcon size={18} color={c.textSecondary} />} />
          <ToolbarButton onPress={() => editorRef.current?.exec('removeFormat')}
            icon={<RemoveFormatting size={18} color={c.textSecondary} />} />

          <View style={styles.formatSep} />

          <ToolbarButton onPress={() => editorRef.current?.exec('undo')}
            icon={<Undo2 size={18} color={c.textSecondary} />} />
          <ToolbarButton onPress={() => editorRef.current?.exec('redo')}
            icon={<Redo2 size={18} color={c.textSecondary} />} />
        </ScrollView>
      </View>

      <Modal
        visible={linkPromptVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLinkPromptVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {t('email_composer.add_link', 'Add link')}
            </Text>
            <Text style={styles.modalLabel}>
              {t('email_composer.link_url_prompt', 'Enter the URL')}
            </Text>
            <TextInput
              style={styles.modalInput}
              value={linkPromptValue}
              onChangeText={setLinkPromptValue}
              placeholder="https://example.com"
              placeholderTextColor={c.textMuted}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              onSubmitEditing={submitLinkPrompt}
            />
            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalCancel}
                onPress={() => setLinkPromptVisible(false)}
                hitSlop={4}
              >
                <Text style={styles.modalCancelText}>
                  {t('email_composer.cancel', 'Cancel')}
                </Text>
              </Pressable>
              <Pressable
                style={styles.modalConfirm}
                onPress={submitLinkPrompt}
                hitSlop={4}
              >
                <Text style={styles.modalConfirmText}>
                  {t('confirm_dialog.confirm', 'Confirm')}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Schedule send sheet */}
      <Modal
        visible={scheduleSheetOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setScheduleSheetOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setScheduleSheetOpen(false)}>
          <Pressable style={styles.scheduleCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>
              {t('email_composer.schedule_send', 'Schedule send')}
            </Text>
            {!jmapClient.hasDelayedSend() && (
              <Text style={styles.scheduleWarning}>
                {t('email_composer.schedule_unsupported_body', 'This mail server does not support scheduled send.')}
              </Text>
            )}
            {schedulePresets.map((preset) => (
              <Pressable
                key={preset.label}
                style={styles.scheduleRow}
                onPress={() => onScheduleConfirm(preset.date)}
              >
                <Clock size={16} color={c.textSecondary} />
                <Text style={styles.scheduleRowLabel}>{preset.label}</Text>
                <Text style={styles.scheduleRowTime}>
                  {preset.date.toLocaleString(undefined, {
                    weekday: 'short', hour: 'numeric', minute: '2-digit',
                  })}
                </Text>
              </Pressable>
            ))}
            <Pressable style={styles.scheduleRow} onPress={startCustomPicker}>
              <Check size={16} color={c.textSecondary} />
              <Text style={styles.scheduleRowLabel}>
                {t('email_composer.schedule_custom', 'Pick date & time…')}
              </Text>
            </Pressable>
            <Pressable
              style={styles.scheduleCancel}
              onPress={() => setScheduleSheetOpen(false)}
            >
              <Text style={styles.modalCancelText}>{t('email_composer.cancel', 'Cancel')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {customStage !== null && Platform.OS === 'ios' && (
        <Modal transparent animationType="fade" onRequestClose={() => setCustomStage(null)}>
          <Pressable style={styles.modalBackdrop} onPress={() => setCustomStage(null)}>
            <Pressable style={styles.scheduleCard} onPress={() => {}}>
              <DateTimePicker
                value={customDraftRef.current}
                mode="datetime"
                display="spinner"
                minimumDate={new Date()}
                onChange={onCustomPickerChange}
              />
              <View style={styles.modalActions}>
                <Pressable style={styles.modalCancel} onPress={() => setCustomStage(null)}>
                  <Text style={styles.modalCancelText}>{t('email_composer.cancel', 'Cancel')}</Text>
                </Pressable>
                <Pressable
                  style={styles.modalConfirm}
                  onPress={() => { setCustomStage(null); onScheduleConfirm(customDraftRef.current); }}
                >
                  <Text style={styles.modalConfirmText}>
                    {t('email_composer.schedule_send', 'Schedule send')}
                  </Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {customStage !== null && Platform.OS !== 'ios' && (
        <DateTimePicker
          value={customDraftRef.current}
          mode={customStage === 'time' ? 'time' : 'date'}
          display="default"
          minimumDate={customStage === 'date' ? new Date() : undefined}
          onChange={onCustomPickerChange}
        />
      )}

      <IdentitySheet
        visible={identitySheetOpen}
        onClose={() => setIdentitySheetOpen(false)}
        identities={identities}
        selectedIdentityId={selectedIdentityId}
        onPick={(identity) => setSelectedIdentityId(identity.id)}
      />
    </SafeAreaView>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  flex: { flex: 1 },
  scrollContent: { flexGrow: 1 },

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
  formatBtnActive: {
    backgroundColor: c.primaryBg,
  },
  formatBtnDisabled: { opacity: 0.4 },
  formatSep: {
    width: 1,
    height: 20,
    backgroundColor: c.borderLight,
    marginHorizontal: 2,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: c.background,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  modalTitle: { ...typography.h3, color: c.text },
  modalLabel: { ...typography.caption, color: c.textSecondary },
  modalInput: {
    ...typography.body,
    color: c.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.borderLight,
    backgroundColor: c.surface,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  modalCancel: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  modalCancelText: { ...typography.bodyMedium, color: c.textSecondary },
  modalConfirm: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: c.primary,
  },
  modalConfirmText: { ...typography.bodyMedium, color: c.primaryForeground },
  scheduleCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: c.background,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  scheduleWarning: {
    ...typography.caption,
    color: c.error,
    marginBottom: spacing.xs,
  },
  scheduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
    minHeight: 44,
  },
  scheduleRowLabel: { ...typography.body, color: c.text, flex: 1 },
  scheduleRowTime: { ...typography.caption, color: c.textMuted },
  scheduleCancel: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  });
}
