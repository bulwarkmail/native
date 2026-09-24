import React from 'react';
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  Keyboard, Dimensions, Platform, ActivityIndicator, Alert, Modal, Switch,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePreventRemove } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  X, Send, Paperclip, ChevronDown, Bold, Italic, Underline, Strikethrough,
  List, ListOrdered, Link2, Link2Off, Image as ImageIcon, Quote,
  Heading1, Heading2, AlignLeft, AlignCenter, AlignRight, RemoveFormatting,
  Undo2, Redo2, FileText, Clock, Check, Palette, Table, LayoutTemplate, MailCheck,
  Users, Tag, Type, Highlighter,
} from 'lucide-react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { Button, IdentitySheet } from '../components';
import { TemplateSheet } from '../components/TemplateSheet';
import RichTextEditor, {
  type RichTextEditorHandle,
  type RichTextSelectionState,
} from '../components/RichTextEditor';
import { useEmailStore } from '../stores/email-store';
import { ownMailboxes } from '../lib/mailbox-tree';
import { useContactsStore, type RecipientSuggestion } from '../stores/contacts-store';
import { useLocaleStore } from '../stores/locale-store';
import { useSettingsStore } from '../stores/settings-store';
import { useAccountStore } from '../stores/account-store';
import { useSendUndoStore } from '../stores/send-undo-store';
import { toast } from '../stores/toast-store';
import { type EmailTemplate } from '../stores/templates-store';
import { getIdentities } from '../api/identity';
import {
  sendEmail, createDraft, destroyEmails, patchKeywordsForEmails, type OutgoingAttachment, type OutgoingEmail,
} from '../api/email';
import { jmapClient, RequestTimeoutError, ScheduleTooLateError } from '../api/jmap-client';
import { uploadBlob, uploadBytes } from '../api/blob';
import { buildReplyRecipients, type ReplySource } from '../lib/reply-recipients';
import { buildReplySubject, buildForwardSubject } from '../lib/subject-prefix';
import { computeReplyThreadingHeaders, generateMessageId, stripMessageIdBrackets } from '../lib/email-threading';
import { escapeHtml, stripDangerousTags } from '../lib/email-html';
import {
  buildInitialHtml, htmlToPlainText, rewriteInlineImages, extractUserAuthoredText,
  rewriteCidImagesForEditor, replaceInlineImagePlaceholders, sniffImageMime, QUOTED_BLOCK_START,
} from '../lib/compose-html';
import { htmlComposeBodyToPlainText, initialPlainTextMode, plainComposeBodyToHtml } from '../lib/compose-format';
import { buildQuoteHeader, formatQuoteDate, quoteHeaderLabels, type QuoteHeaderLabels } from '../lib/quote-header';
import {
  isValidEmail, splitPastedRecipients, expandRecipients, parseRecipient, type Recipient as ParsedRecipient,
} from '../lib/recipients';
import {
  findComposeIdentityId, findDraftIdentityId, resolveComposeAccountEmail, resolveReplyIdentity,
} from '../lib/reply-identity';
import { shouldBlockEditorRemoteImages } from '../lib/editor-html';
import {
  signatureIdentityFor, buildEmbeddedSignatureHtml, containsEmbeddedSignature, spliceSignature,
  insertSignatureAboveQuote, getPlainTextSignature, appendPlainTextSignature,
  plainTextBodyHasSignature, plainTextBodyWithoutSignature, SIGNATURE_RANGE_MARKER,
} from '../lib/signature-utils';
import {
  getAutoFilledPlaceholders, getPlaceholdersFromTemplate, substitutePlaceholders, templateBodyToHtml,
} from '../lib/template-utils';
import {
  generateSubAddress, extractDomain, suggestTagsForDomain, getTagValidationError, MAX_TAG_LENGTH,
} from '../lib/sub-addressing';
import { sanitizeDisplayName } from '../lib/rfc5322-mailbox';
import type { EmailAddress, Identity } from '../api/types';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Compose'>;

/** A recipient chip. Group chips carry their resolved members and no email. */
interface Recipient {
  name: string;
  email: string;
  group?: { members: Array<{ name?: string; email: string }> };
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
  /** 0..1 while uploading, when the transport reports it. */
  progress?: number;
  error?: string;
  abort?: AbortController;
};

type Field = 'to' | 'cc' | 'bcc';

const URL_RE = /^https?:\/\/.+/i;

// The webmail's 2 x 8 palette, used for text and background colour alike.
const TEXT_COLORS = [
  '#000000', '#5f6368', '#9aa0a6', '#c5221f', '#e8710a', '#f9ab00', '#188038', '#1967d2',
  '#7627bb', '#c2185b', '#795548', '#fa5252', '#fd7e14', '#40c057', '#4dabf7', '#e64980',
];

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

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const n = (bytes[i] << 16) | (rem === 2 ? bytes[i + 1] << 8 : 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (rem === 2 ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}

function toRecipient(r: { name?: string | null; email?: string | null }): Recipient | null {
  if (!r.email) return null;
  return { name: r.name ?? '', email: r.email };
}

function toRecipientList(list: Array<{ name?: string | null; email?: string | null }> | undefined | null): Recipient[] {
  return (list ?? []).map(toRecipient).filter((r): r is Recipient => !!r);
}

function fromParsed(r: ParsedRecipient): Recipient {
  return { name: r.name ?? '', email: r.email, group: r.group };
}

function toAddress(r: { name?: string; email: string }): EmailAddress {
  return r.name ? { name: r.name, email: r.email } : { email: r.email };
}

function chipIsValid(r: Recipient): boolean {
  return r.group ? r.group.members.length > 0 : isValidEmail(r.email);
}

/** Strip the editor's structural markers before the HTML leaves the device. */
function stripEditorMarkers(html: string): string {
  return html
    .replace(new RegExp(`\\s${SIGNATURE_RANGE_MARKER}=("[^"]*"|'[^']*')`, 'g'), '')
    .replace(/\sdata-quoted-html=("[^"]*"|'[^']*')/g, '');
}

function quoteLines(text: string): string {
  return text.split('\n').map((l) => `> ${l}`).join('\n');
}

function RecipientChip({
  recipient, invalid, onRemove, onLongPress,
}: {
  recipient: Recipient;
  invalid?: boolean;
  onRemove: () => void;
  onLongPress?: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const label = recipient.group
    ? t('email_composer.group_chip', '{name} ({count})', {
      name: recipient.name || t('contacts.group', 'Group'),
      count: recipient.group.members.length,
    })
    : recipient.name || recipient.email;
  return (
    <Pressable onLongPress={onLongPress} delayLongPress={350} style={[styles.chip, invalid && styles.chipInvalid]}>
      {recipient.group && <Users size={12} color={c.textSecondary} />}
      <Text style={[styles.chipText, invalid && styles.chipTextInvalid]} numberOfLines={1}>
        {label}
      </Text>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('email_composer.recipient_remove', 'Remove')}
      >
        <X size={12} color={invalid ? c.error : c.textMuted} />
      </Pressable>
    </Pressable>
  );
}

function initialsOf(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? parts[1][0] : '';
  return `${first}${second}`.toUpperCase();
}

function SuggestionList({
  suggestions, onPick, onPressIn,
}: {
  suggestions: RecipientSuggestion[];
  onPick: (s: RecipientSuggestion) => void;
  onPressIn?: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  return (
    <View style={styles.suggestionBox}>
      {suggestions.map((s, i) => (
        <Pressable
          key={`${s.group?.id ?? s.email}-${i}`}
          onPressIn={onPressIn}
          onPress={() => onPick(s)}
          style={({ pressed }) => [styles.suggestionRow, pressed && styles.suggestionRowPressed]}
        >
          <View style={styles.suggestionAvatar}>
            {s.group
              ? <Users size={14} color={c.primary} />
              : <Text style={styles.suggestionAvatarText}>{initialsOf(s.name, s.email)}</Text>}
          </View>
          <View style={styles.suggestionText}>
            <Text style={styles.suggestionName} numberOfLines={1}>
              {s.name || s.email}
            </Text>
            {s.group ? (
              <Text style={styles.suggestionEmail} numberOfLines={1}>
                {t('contacts.groups.member_count', '{count, plural, =0 {No members} one {1 member} other {# members}}', { count: s.group.memberCount })}
              </Text>
            ) : !!s.name && (
              <Text style={styles.suggestionEmail} numberOfLines={1}>{s.email}</Text>
            )}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function AttachmentChip({
  attachment, onRemove, onPress,
}: {
  attachment: AttachmentEntry;
  onRemove: () => void;
  onPress: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const pct = attachment.progress != null ? Math.round(attachment.progress * 100) : null;
  return (
    <Pressable onPress={onPress} style={styles.attachmentChip} disabled={attachment.uploading}>
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
        <Text style={[styles.attachmentSize, !!attachment.error && { color: c.error }]} numberOfLines={1}>
          {attachment.error
            ? attachment.error
            : attachment.uploading
              ? pct != null
                ? t('email_composer.uploading_pct', 'Uploading {pct}%', { pct })
                : t('email_composer.uploading', 'Uploading...')
              : formatBytes(attachment.size)}
        </Text>
        {attachment.uploading && pct != null && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${pct}%` }]} />
          </View>
        )}
      </View>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        style={styles.attachmentRemove}
        accessibilityRole="button"
        accessibilityLabel={attachment.uploading
          ? t('email_composer.upload_cancel', 'Cancel upload')
          : t('email_composer.remove_attachment', 'Remove attachment')}
      >
        <X size={14} color={c.textMuted} />
      </Pressable>
    </Pressable>
  );
}

function ToolbarButton({
  active, onPress, icon, disabled, label,
}: {
  active?: boolean;
  onPress: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  label?: string;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      disabled={disabled}
      accessibilityLabel={label}
      style={[styles.formatBtn, active && styles.formatBtnActive, disabled && styles.formatBtnDisabled]}
    >
      {icon}
    </Pressable>
  );
}

interface SheetOption {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

/** Simple action list (Android's Alert caps at three buttons). */
function OptionsSheet({
  visible, title, options, onClose, cancelLabel,
}: {
  visible: boolean;
  title?: string;
  options: SheetOption[];
  onClose: () => void;
  cancelLabel: string;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.scheduleCard} onPress={() => {}}>
          {!!title && <Text style={styles.modalTitle} numberOfLines={2}>{title}</Text>}
          {options.map((opt) => (
            <Pressable
              key={opt.label}
              style={styles.scheduleRow}
              onPress={() => { onClose(); opt.onPress(); }}
            >
              <Text style={[styles.scheduleRowLabel, opt.destructive && { color: c.error }]}>{opt.label}</Text>
            </Pressable>
          ))}
          <Pressable style={styles.scheduleCancel} onPress={onClose}>
            <Text style={styles.modalCancelText}>{cancelLabel}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
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
  const draft = route.params?.draft;
  const mode = route.params?.mode ?? 'compose';
  const prefillTo = route.params?.prefillTo;
  const prefillCc = route.params?.prefillCc;
  const prefillBcc = route.params?.prefillBcc;
  const prefillSubject = route.params?.prefillSubject;
  const prefillBody = route.params?.prefillBody;
  const prefillAttachments = route.params?.prefillAttachments;
  const isReplyLike = !!replyTo && !draft;
  const mailboxes = useEmailStore((s) => s.mailboxes);
  // Always the user's own Sent — composing on behalf of a shared account
  // isn't supported, so a group account's Sent must never be picked up here.
  const sentMailbox = React.useMemo(
    () => ownMailboxes(mailboxes).find((m) => m.role === 'sent'),
    [mailboxes],
  );
  // The message is created in Drafts and moved to Sent by the submission's
  // onSuccessUpdateEmail, so a failed send never leaves a fake sent copy (#188).
  const draftsMailbox = React.useMemo(
    () => ownMailboxes(mailboxes).find((m) => m.role === 'drafts'),
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
  const replyIdentityMatch = useSettingsStore((s) => s.replyIdentityMatch);
  // Per-message format (#1022): seeded from the "plain text only" setting,
  // or the format a reopened draft was written in, and switchable from the
  // toolbar for just this message.
  const plainTextSetting = useSettingsStore((s) => s.plainTextMode);
  const [plainTextMode, setPlainTextMode] = React.useState(() => initialPlainTextMode(draft, plainTextSetting));
  const attachmentReminderEnabled = useSettingsStore((s) => s.attachmentReminderEnabled);
  const attachmentReminderKeywords = useSettingsStore((s) => s.attachmentReminderKeywords);
  const sendDelaySeconds = useSettingsStore((s) => s.sendDelaySeconds);
  const signaturePosition = useSettingsStore((s) => s.signaturePosition);
  const signatureSeparatorEnabled = useSettingsStore((s) => s.signatureSeparatorEnabled);
  const requestReadReceiptDefault = useSettingsStore((s) => s.requestReadReceiptDefault);
  const emptySubjectWarningEnabled = useSettingsStore((s) => s.emptySubjectWarningEnabled);
  const autoSaveDraftInterval = useSettingsStore((s) => s.autoSaveDraftInterval);
  const subAddressDelimiter = useSettingsStore((s) => s.subAddressDelimiter);
  const preferredIdentityIds = useSettingsStore((s) => s.preferredIdentityIds);
  const trustedSendersAddressBook = useSettingsStore((s) => s.trustedSendersAddressBook);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const quoteLabels = React.useMemo<QuoteHeaderLabels>(() => quoteHeaderLabels(t), [t]);

  // Every address that is "us": the login, the account's primary address and
  // every identity. Reply-all must not send the user a copy, and replying to
  // a self-sent message continues to its original recipients (#703).
  const ownEmails = React.useMemo(() => {
    const out = new Set<string>();
    const active = useAccountStore.getState().getActiveAccount();
    for (const e of [active?.email, active?.username, jmapClient.username]) {
      if (e && e.includes('@')) out.add(e);
    }
    for (const i of identities) if (i.email) out.add(i.email);
    return Array.from(out);
  }, [identities]);

  const replySource = React.useMemo<ReplySource | undefined>(
    () => (replyTo
      ? {
          from: replyTo.from.email ? [replyTo.from] : [],
          replyToAddresses: replyTo.replyToAddresses,
          to: replyTo.to,
          cc: replyTo.cc,
        }
      : undefined),
    [replyTo],
  );

  const initialTo = React.useMemo<Recipient[]>(() => {
    if (draft) return toRecipientList(draft.to);
    if (!replyTo) return toRecipientList(prefillTo);
    if (mode === 'forward') return [];
    return toRecipientList(
      buildReplyRecipients(replySource, mode === 'replyAll' ? 'replyAll' : 'reply', ownEmails).to,
    );
    // Seeds state once; identity-based refinement happens in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyTo, draft, mode, prefillTo]);

  const initialCc = React.useMemo<Recipient[]>(() => {
    if (draft) return toRecipientList(draft.cc);
    if (!replyTo) return toRecipientList(prefillCc);
    if (mode !== 'replyAll') return [];
    return toRecipientList(buildReplyRecipients(replySource, 'replyAll', ownEmails).cc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyTo, draft, mode, prefillCc]);

  const initialBcc = React.useMemo<Recipient[]>(
    () => (draft ? toRecipientList(draft.bcc) : toRecipientList(prefillBcc)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft],
  );

  const initialSubject = React.useMemo(() => {
    if (draft) return draft.subject ?? '';
    if (!replyTo) return prefillSubject ?? '';
    // Strip stacked / foreign-language prefixes (AW:, WG:, Re[2]:) before
    // adding the locale's own so the chain doesn't grow on every hop.
    if (mode === 'forward') {
      return buildForwardSubject(replyTo.subject, t('email_composer.prefix.forward', 'Fwd:'));
    }
    return buildReplySubject(replyTo.subject, t('email_composer.prefix.reply', 'Re:'));
  }, [replyTo, draft, mode, prefillSubject, t]);

  // The quoted HTML with `cid:` images swapped for placeholders that carry
  // the cid; the hydration effect below fetches the blobs (#163/#543).
  const seedHtml = React.useMemo(() => {
    const raw = draft ? draft.htmlBody : replyTo?.htmlBody;
    if (!raw) return { html: undefined as string | undefined, cids: [] as string[] };
    const { html, cids } = rewriteCidImagesForEditor(stripDangerousTags(raw));
    return { html, cids };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remote images in a quoted original stay blocked in the editor whenever
  // the viewer blocks them; the sent HTML keeps them. Read once: the editor
  // page is built on mount.
  const blockRemoteImages = React.useMemo(() => {
    const settings = useSettingsStore.getState();
    const sender = replyTo?.from.email?.trim().toLowerCase();
    return shouldBlockEditorRemoteImages({
      seedHtml: draft ? draft.htmlBody : replyTo?.htmlBody,
      isDraft: !!draft,
      externalContentPolicy: settings.externalContentPolicy,
      senderTrusted: !!sender && (
        settings.isSenderTrusted(sender)
        || useContactsStore.getState().trustedSenderEmails.includes(sender)
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const initialBodyHtml = React.useMemo(
    () => {
      if (draft) {
        if (seedHtml.html) return seedHtml.html;
        if (draft.textBody) return `<div>${escapeHtml(draft.textBody).replace(/\r?\n/g, '<br>')}</div>`;
        return '<p><br></p>';
      }
      if (!replyTo) {
        return prefillBody
          ? `<div>${escapeHtml(prefillBody).replace(/\r?\n/g, '<br>')}</div><p><br></p>`
          : '<p><br></p>';
      }
      // Quick reply "More options" hands the typed text over as prefillBody;
      // it goes above the quote.
      const typed = prefillBody
        ? `<div>${escapeHtml(prefillBody).replace(/\r?\n/g, '<br>')}</div>`
        : '';
      return typed + buildInitialHtml(mode, {
        from: { name: replyTo.from.name, email: replyTo.from.email },
        to: replyTo.to,
        cc: replyTo.cc,
        subject: replyTo.subject,
        body: replyTo.body,
        htmlBody: seedHtml.html,
        receivedAt: replyTo.sentAt ?? replyTo.receivedAt,
      }, { timeFormat, locale, unknownLabel: t('common.unknown', 'Unknown'), labels: quoteLabels });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Plain-text mode seed: the same quote as text, `> `-prefixed for replies.
  const initialPlainBody = React.useMemo(() => {
    if (draft) return draft.textBody ?? (draft.htmlBody ? htmlToPlainText(stripDangerousTags(draft.htmlBody)) : '');
    if (!replyTo) return prefillBody ?? '';
    const header = buildQuoteHeader({
      mode: mode === 'compose' ? 'reply' : mode,
      email: { from: replyTo.from, subject: replyTo.subject, receivedAt: replyTo.sentAt ?? replyTo.receivedAt },
      timeFormat,
      locale,
      unknownLabel: t('common.unknown', 'Unknown'),
      labels: quoteLabels,
    });
    const body = replyTo.body ?? (replyTo.htmlBody ? htmlToPlainText(stripDangerousTags(replyTo.htmlBody)) : '');
    if (!body) return '';
    if (mode === 'forward') return `\n\n${header.text}\n${body}`;
    return `\n\n${header.text}${quoteLines(body)}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attachments carried over from the original (forward) or the re-opened
  // draft. Blobs are account-scoped: a message in a shared/group account has
  // to be re-uploaded into the user's own account before it can be sent.
  // Inline images referenced from the quoted body are hydrated separately
  // and never shown as file chips.
  const seedAttachments = replyTo?.attachments ?? draft?.attachments;
  const seedOwnerAccountId = replyTo?.jmapAccountId ?? draft?.jmapAccountId;
  const seedCidSet = React.useMemo(() => new Set(seedHtml.cids), [seedHtml.cids]);
  const isSeedInline = React.useCallback(
    (a: { cid?: string; disposition?: string }) =>
      !!a.cid && seedCidSet.has(stripMessageIdBrackets(a.cid)),
    [seedCidSet],
  );
  const initialAttachments = React.useMemo<AttachmentEntry[]>(() => {
    if (!seedAttachments?.length) return [];
    return seedAttachments
      .filter((a) => !!a.blobId && !isSeedInline(a))
      .map((a) => ({
        localId: `seed-${a.blobId}`,
        name: a.name || 'attachment',
        type: a.type || 'application/octet-stream',
        size: a.size ?? 0,
        uri: '',
        inline: false,
        blobId: seedOwnerAccountId ? undefined : a.blobId,
        uploading: !!seedOwnerAccountId,
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [toRecipients, setToRecipients] = React.useState<Recipient[]>(initialTo);
  const [ccRecipients, setCcRecipients] = React.useState<Recipient[]>(initialCc);
  const [bccRecipients, setBccRecipients] = React.useState<Recipient[]>(initialBcc);
  const [ccVisible, setCcVisible] = React.useState(initialCc.length > 0 || initialBcc.length > 0);
  const [bccVisible, setBccVisible] = React.useState(initialBcc.length > 0);
  const [toInput, setToInput] = React.useState('');
  const [ccInput, setCcInput] = React.useState('');
  const [bccInput, setBccInput] = React.useState('');
  const [subject, setSubject] = React.useState(initialSubject);
  const [bodyHtml, setBodyHtml] = React.useState(initialBodyHtml);
  // What the editor page is built from when it mounts: the initial body, or
  // the converted one after a switch from plain text.
  const [editorSeedHtml, setEditorSeedHtml] = React.useState(initialBodyHtml);
  const [plainBody, setPlainBody] = React.useState(initialPlainBody);
  const plainSelectionRef = React.useRef<{ start: number; end: number } | null>(null);
  const [activeField, setActiveField] = React.useState<Field | null>(null);
  const [attachments, setAttachments] = React.useState<AttachmentEntry[]>(initialAttachments);
  const [requestReadReceipt, setRequestReadReceipt] = React.useState(requestReadReceiptDefault);
  const [subAddressTag, setSubAddressTag] = React.useState('');
  const [fromOverride, setFromOverride] = React.useState<{ name: string; email: string } | null>(null);
  const [selState, setSelState] = React.useState<RichTextSelectionState>({
    bold: false, italic: false, underline: false, strikeThrough: false,
    ul: false, ol: false, blockquote: false, h1: false, h2: false,
    alignLeft: false, alignCenter: false, alignRight: false, link: false,
  });

  const editorRef = React.useRef<RichTextEditorHandle>(null);
  const isPickingSuggestion = React.useRef(false);
  // Track inline-image placeholders that haven't yet been rewritten to cid:
  // until send time. Maps cid → blobId/type/name/size.
  const inlineRegistryRef = React.useRef<Map<string, AttachmentEntry>>(new Map());

  const getAutocomplete = useContactsStore((s) => s.getAutocomplete);
  const getGroupRecipients = useContactsStore((s) => s.getGroupRecipients);
  const loadRecentRecipients = useContactsStore((s) => s.loadRecentRecipients);
  const contactsVersion = useContactsStore((s) => s.contacts);
  const recentVersion = useContactsStore((s) => s.recentRecipients);

  React.useEffect(() => {
    if (sentMailbox?.id) void loadRecentRecipients(sentMailbox.id);
  }, [sentMailbox?.id, loadRecentRecipients]);

  const inputFor = (field: Field | null) =>
    field === 'to' ? toInput : field === 'cc' ? ccInput : field === 'bcc' ? bccInput : '';
  const suggestionQuery = inputFor(activeField);
  const alreadySelected = React.useMemo(
    () => new Set(
      [...toRecipients, ...ccRecipients, ...bccRecipients]
        .flatMap((r) => (r.group ? r.group.members.map((m) => m.email) : [r.email]))
        .map((e) => e.toLowerCase()),
    ),
    [toRecipients, ccRecipients, bccRecipients],
  );
  const suggestions = React.useMemo<RecipientSuggestion[]>(() => {
    const q = suggestionQuery.trim();
    if (q.length < 1) return [];
    return getAutocomplete(q, 16)
      .filter((s) => s.group || !alreadySelected.has(s.email.toLowerCase()))
      .slice(0, 8);
    // contactsVersion/recentVersion re-run the lookup when the store loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestionQuery, alreadySelected, getAutocomplete, contactsVersion, recentVersion]);

  const setterFor = (field: Field) =>
    field === 'to' ? setToRecipients : field === 'cc' ? setCcRecipients : setBccRecipients;
  const inputSetterFor = (field: Field) =>
    field === 'to' ? setToInput : field === 'cc' ? setCcInput : setBccInput;

  const pickSuggestion = (s: RecipientSuggestion) => {
    isPickingSuggestion.current = true;
    const field = activeField ?? 'to';
    let recipient: Recipient;
    if (s.group) {
      const members = getGroupRecipients(s.group.id)
        .filter((m) => !alreadySelected.has(m.email.toLowerCase()))
        .map((m) => ({ name: m.name || undefined, email: m.email }));
      if (members.length === 0) {
        inputSetterFor(field)('');
        return;
      }
      recipient = { name: s.name, email: '', group: { members } };
    } else {
      recipient = { name: s.name, email: s.email };
    }
    setterFor(field)((prev) => [...prev, recipient]);
    inputSetterFor(field)('');
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

  // Once the identities are known, recompute the reply recipients so every
  // own alias is dropped from a reply-all (the initial seed only knew the
  // login address). Skipped when the user already edited the fields.
  const recipientsRefinedRef = React.useRef(false);
  React.useEffect(() => {
    if (recipientsRefinedRef.current || identities.length === 0) return;
    if (!isReplyLike || mode === 'forward') return;
    recipientsRefinedRef.current = true;
    const sameList = (a: Recipient[], b: Recipient[]) =>
      a.length === b.length && a.every((r, i) => r.email === b[i].email);
    if (!sameList(toRecipients, initialTo) || !sameList(ccRecipients, initialCc)) return;
    const { to, cc } = buildReplyRecipients(
      replySource,
      mode === 'replyAll' ? 'replyAll' : 'reply',
      ownEmails,
    );
    const nextTo = toRecipientList(to);
    const nextCc = toRecipientList(cc);
    if (!sameList(nextTo, toRecipients)) setToRecipients(nextTo);
    if (!sameList(nextCc, ccRecipients)) {
      setCcRecipients(nextCc);
      if (nextCc.length > 0) setCcVisible(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identities]);

  // Re-upload attachments that live in another account's blob store (forward
  // from a shared folder) into the user's own account.
  React.useEffect(() => {
    if (!seedOwnerAccountId || !seedAttachments?.length) return;
    let cancelled = false;
    void (async () => {
      for (const a of seedAttachments) {
        if (!a.blobId || isSeedInline(a)) continue;
        const localId = `seed-${a.blobId}`;
        try {
          const buf = await jmapClient.fetchBlobArrayBuffer(a.blobId, a.name, a.type, seedOwnerAccountId);
          const up = await uploadBytes(new Uint8Array(buf), a.type || 'application/octet-stream');
          if (!cancelled) updateAttachment(localId, { blobId: up.blobId, size: up.size, uploading: false });
        } catch (e) {
          if (!cancelled) {
            updateAttachment(localId, {
              uploading: false,
              error: e instanceof Error ? e.message : t('email_composer.upload_failed_short', 'Upload failed'),
            });
          }
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hydrate the quoted original's inline images: fetch each cid's blob, show
  // it as a data URL and register the part so it is re-attached inline on
  // send (#163/#543). Cross-account blobs are re-uploaded into our account.
  React.useEffect(() => {
    if (seedHtml.cids.length === 0 || !seedAttachments?.length) return;
    let cancelled = false;
    void (async () => {
      const map = new Map<string, string>();
      for (const cid of seedHtml.cids) {
        const att = seedAttachments.find((a) => a.cid && stripMessageIdBrackets(a.cid) === cid && a.blobId);
        if (!att?.blobId) continue;
        try {
          const buf = await jmapClient.fetchBlobArrayBuffer(att.blobId, att.name, att.type, seedOwnerAccountId);
          const bytes = new Uint8Array(buf);
          const mime = att.type?.toLowerCase().startsWith('image/') ? att.type : (sniffImageMime(bytes) ?? 'image/png');
          map.set(cid, `data:${mime};base64,${bytesToBase64(bytes)}`);
          let blobId = att.blobId;
          if (seedOwnerAccountId) blobId = (await uploadBytes(bytes, mime)).blobId;
          inlineRegistryRef.current.set(cid, {
            localId: `cid-${cid}`,
            name: att.name || 'image',
            type: mime,
            size: att.size ?? bytes.byteLength,
            uri: '',
            inline: true,
            cid,
            blobId,
            uploading: false,
          });
        } catch (err) {
          console.warn('[compose] inline image hydration failed', err);
        }
      }
      if (cancelled || map.size === 0) return;
      let live = latestRef.current.bodyHtml;
      try {
        live = (await editorRef.current?.getHtml()) ?? live;
      } catch { /* fall back to the last change message */ }
      const next = replaceInlineImagePlaceholders(live, map);
      if (next !== live) {
        setBodyHtml(next);
        editorRef.current?.setHtml(next);
      }
      // The hydrated images are part of the untouched baseline, not an edit.
      baselineRef.current = replaceInlineImagePlaceholders(baselineRef.current, map);
      if (lastSavedRef.current) lastSavedRef.current = replaceInlineImagePlaceholders(lastSavedRef.current, map);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new message started while a shared folder is open sends as that
  // mailbox's owner when the user has an identity for it (webmail 129f545a).
  // Read once: it is the folder the message was started from. Own folders
  // resolve to nothing, so they keep the preferred identity below.
  const composeFromAccountEmail = React.useMemo(() => {
    const { mailboxes: all, currentMailboxId } = useEmailStore.getState();
    return resolveComposeAccountEmail(all, currentMailboxId);
  }, []);

  // Choose the identity once we know both the loaded identities and the
  // compose context: a re-opened draft keeps the identity it was written
  // with; a new message in a shared folder uses that folder's identity; a
  // reply or forward sends from the own identity the original was delivered
  // to (a reply to our own message, from the one that sent it); with
  // auto-select on, a reply to a catch-all alias on an owned domain takes
  // that address as a From override; otherwise the preferred ("Use as
  // default") identity, else the one matching the active account.
  React.useEffect(() => {
    if (selectedIdentityId || identities.length === 0) return;
    const activeEmail = useAccountStore.getState().getActiveAccount()?.email || jmapClient.username;
    const preferredId = preferredIdentityIds[jmapClient.accountId];
    const defaultIdentity =
      identities.find((i) => i.id === preferredId)
      ?? identities.find((i) => i.email.toLowerCase() === activeEmail?.toLowerCase())
      ?? identities.find((i) => !i.mayDelete)
      ?? identities[0];

    if (draft) {
      const matched = findDraftIdentityId(identities, draft.from?.[0]);
      setSelectedIdentityId(matched ?? defaultIdentity.id);
      return;
    }
    if (!replyTo) {
      const composeId = findComposeIdentityId(identities, composeFromAccountEmail);
      if (composeId) {
        setSelectedIdentityId(composeId);
        return;
      }
    }
    if (replyTo) {
      // The catch-all From rewrite is opt-in and never used on a forward.
      const resolved = resolveReplyIdentity(identities, replyTo, {
        ownEmails,
        catchAll: autoSelectReplyIdentity && mode !== 'forward',
        matchMode: replyIdentityMatch,
      });
      if (resolved) {
        setSelectedIdentityId(resolved.identityId);
        if (resolved.overrideEmail) {
          setFromOverride({ name: resolved.overrideName ?? '', email: resolved.overrideEmail });
        }
        return;
      }
    }
    setSelectedIdentityId(defaultIdentity.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identities, autoSelectReplyIdentity, replyIdentityMatch, replyTo, draft, selectedIdentityId, preferredIdentityIds]);

  const primaryIdentity = React.useMemo(() => {
    if (identities.length === 0) return null;
    const activeEmail = useAccountStore.getState().getActiveAccount()?.email || jmapClient.username;
    const defaultIdentity = identities.find(
      (i) => i.email.toLowerCase() === activeEmail?.toLowerCase()
    ) ?? identities[0];
    return identities.find((i) => i.id === selectedIdentityId) ?? defaultIdentity;
  }, [identities, selectedIdentityId]);

  // An alias without a signature falls back to the primary identity's.
  const signatureIdentity = React.useMemo(
    () => signatureIdentityFor(primaryIdentity, identities),
    [primaryIdentity, identities],
  );

  const openIdentityPicker = () => {
    if (identities.length <= 1) return;
    setIdentitySheetOpen(true);
  };

  // ── Recipients ───────────────────────────────────────────────────────

  // Typed-but-uncommitted text is parsed the same way a paste is; leftovers
  // that are not addresses count as invalid and block Send.
  const typedRecipients = React.useMemo(() => {
    const parseField = (input: string, existing: Recipient[]) => {
      if (!input.trim()) return { valid: [] as Recipient[], invalid: [] as string[] };
      const { valid, invalid } = splitPastedRecipients(input, Array.from(alreadySelected));
      return {
        valid: valid.map(fromParsed).filter((r) => !existing.some((e) => e.email.toLowerCase() === r.email.toLowerCase())),
        invalid,
      };
    };
    return {
      to: parseField(toInput, toRecipients),
      cc: parseField(ccInput, ccRecipients),
      bcc: parseField(bccInput, bccRecipients),
    };
  }, [toInput, ccInput, bccInput, toRecipients, ccRecipients, bccRecipients, alreadySelected]);

  const finalTo = React.useMemo(() => [...toRecipients, ...typedRecipients.to.valid], [toRecipients, typedRecipients]);
  const finalCc = React.useMemo(() => [...ccRecipients, ...typedRecipients.cc.valid], [ccRecipients, typedRecipients]);
  const finalBcc = React.useMemo(() => [...bccRecipients, ...typedRecipients.bcc.valid], [bccRecipients, typedRecipients]);
  const invalidTyped = [...typedRecipients.to.invalid, ...typedRecipients.cc.invalid, ...typedRecipients.bcc.invalid];

  // Move what was typed into chips (blur / submit). Unparseable leftovers
  // stay in the input so nothing the user typed is silently dropped.
  const addTyped = (field?: Field) => {
    const fields: Field[] = field ? [field] : ['to', 'cc', 'bcc'];
    for (const f of fields) {
      const parsed = typedRecipients[f];
      if (parsed.valid.length) {
        setterFor(f)((prev) => {
          const existing = new Set(prev.flatMap((r) => (r.group ? r.group.members.map((m) => m.email) : [r.email])).map((e) => e.toLowerCase()));
          const unique = parsed.valid.filter((r) => !existing.has(r.email.toLowerCase()));
          return unique.length ? [...prev, ...unique] : prev;
        });
      }
      const leftover = parsed.invalid.join(' ');
      if (leftover !== inputFor(f)) inputSetterFor(f)(leftover);
    }
  };

  const [chipMenu, setChipMenu] = React.useState<{ field: Field; index: number } | null>(null);
  const chipMenuRecipient = chipMenu ? (chipMenu.field === 'to' ? toRecipients : chipMenu.field === 'cc' ? ccRecipients : bccRecipients)[chipMenu.index] : null;
  const removeChip = (field: Field, index: number) =>
    setterFor(field)((prev) => prev.filter((_, i) => i !== index));
  const moveChip = (from: Field, index: number, to: Field) => {
    const list = from === 'to' ? toRecipients : from === 'cc' ? ccRecipients : bccRecipients;
    const r = list[index];
    if (!r) return;
    removeChip(from, index);
    setterFor(to)((prev) => [...prev, r]);
    if (to === 'cc') setCcVisible(true);
    if (to === 'bcc') { setCcVisible(true); setBccVisible(true); }
  };
  const chipMenuOptions = React.useMemo<SheetOption[]>(() => {
    if (!chipMenu || !chipMenuRecipient) return [];
    const r = chipMenuRecipient;
    const fieldLabel = (f: Field) => (f === 'to' ? t('email_composer.to', 'To') : f === 'cc' ? t('email_composer.cc', 'Cc') : t('email_composer.bcc', 'Bcc'));
    const opts: SheetOption[] = [];
    for (const target of (['to', 'cc', 'bcc'] as Field[]).filter((f) => f !== chipMenu.field)) {
      opts.push({
        label: t('email_composer.recipient_move_to', 'Move to {field}', { field: fieldLabel(target) }),
        onPress: () => moveChip(chipMenu.field, chipMenu.index, target),
      });
    }
    if (!r.group) {
      opts.push({
        label: t('email_composer.recipient_copy', 'Copy address'),
        onPress: () => { void Clipboard.setStringAsync(r.email); },
      });
      opts.push({
        label: t('email_composer.recipient_add_contact', 'Add to contacts'),
        onPress: () => navigation.navigate('ContactForm', { prefill: { email: r.email, name: r.name || undefined } }),
      });
    }
    opts.push({
      label: t('email_composer.recipient_remove', 'Remove'),
      destructive: true,
      onPress: () => removeChip(chipMenu.field, chipMenu.index),
    });
    return opts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chipMenu, chipMenuRecipient, t]);

  const hasUploadInFlight = attachments.some((a) => a.uploading);
  const hasUploadError = attachments.some((a) => !!a.error);
  const allChipsValid = [...finalTo, ...finalCc, ...finalBcc].every(chipIsValid);
  const hasValidRecipients = finalTo.length > 0 && allChipsValid && invalidTyped.length === 0;
  const bodyPlain = React.useMemo(
    () => (plainTextMode ? plainBody : htmlToPlainText(bodyHtml)),
    [plainTextMode, plainBody, bodyHtml],
  );
  const hasBodyContent = bodyPlain.trim().length > 0
    || attachments.some((a) => a.blobId && !a.error);
  const canSend =
    !sending &&
    !hasUploadInFlight &&
    !hasUploadError &&
    hasValidRecipients &&
    hasBodyContent &&
    !!primaryIdentity &&
    !!sentMailbox;

  // ── Dirty tracking / drafts ──────────────────────────────────────────

  const snapshotOf = (s: {
    to: Recipient[]; cc: Recipient[]; bcc: Recipient[]; subject: string; body: string;
    attachments: AttachmentEntry[];
  }) => JSON.stringify({
    to: s.to.map((r) => [r.name, r.email, r.group?.members.map((m) => m.email)]),
    cc: s.cc.map((r) => [r.name, r.email, r.group?.members.map((m) => m.email)]),
    bcc: s.bcc.map((r) => [r.name, r.email, r.group?.members.map((m) => m.email)]),
    subject: s.subject,
    body: s.body,
    att: s.attachments.filter((a) => !a.inline).map((a) => a.blobId ?? a.localId),
  });

  // Memoized: the snapshot copies the whole body, and the screen re-renders
  // for plenty that doesn't touch it (PF8).
  const currentSnapshot = React.useMemo(() => snapshotOf({
    to: finalTo, cc: finalCc, bcc: finalBcc, subject,
    body: plainTextMode ? plainBody : bodyHtml, attachments,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [finalTo, finalCc, finalBcc, subject, plainTextMode, plainBody, bodyHtml, attachments]);
  const baselineRef = React.useRef(snapshotOf({
    to: initialTo, cc: initialCc, bcc: initialBcc, subject: initialSubject,
    body: plainTextMode ? initialPlainBody : initialBodyHtml, attachments: initialAttachments,
  }));
  // Snapshot at the last successful draft save (null = never saved).
  const lastSavedRef = React.useRef<string | null>(draft ? baselineRef.current : null);
  const draftIdRef = React.useRef<string | null>(draft?.id ?? null);
  const messageIdRef = React.useRef<string | null>(draft?.messageId?.[0] ?? null);
  const inflightSaveRef = React.useRef<Promise<string | null> | null>(null);
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaveAtRef = React.useRef(0);
  const allowLeaveRef = React.useRef(false);
  const sendingRef = React.useRef(false);
  const [draftStatus, setDraftStatus] = React.useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [savingDraft, setSavingDraft] = React.useState(false);

  const isDirty = currentSnapshot !== baselineRef.current;
  const needsSave = currentSnapshot !== (lastSavedRef.current ?? baselineRef.current);

  // Latest state for callbacks that outlive a render (autosave timer,
  // beforeRemove listener, hydration).
  const latestRef = React.useRef({ bodyHtml, plainBody, isDirty, needsSave, currentSnapshot });
  latestRef.current = { bodyHtml, plainBody, isDirty, needsSave, currentSnapshot };

  // ── Signature ────────────────────────────────────────────────────────

  const placeSignatureHtml = React.useCallback((html: string, sigHtml: string): string => {
    if (!sigHtml) return html;
    if (isReplyLike && signaturePosition === 'above_quote') {
      return insertSignatureAboveQuote(html, sigHtml, QUOTED_BLOCK_START);
    }
    return `${html}${sigHtml}`;
  }, [isReplyLike, signaturePosition]);

  const placeSignaturePlain = React.useCallback((body: string, identity: Identity): string => {
    const sig = getPlainTextSignature(identity);
    if (!sig) return body;
    const sep = signatureSeparatorEnabled ? '\n\n-- \n' : '\n\n';
    if (isReplyLike && signaturePosition === 'above_quote') {
      const idx = body.indexOf('\n\n');
      const head = idx === -1 ? body : body.slice(0, idx);
      const tail = idx === -1 ? '' : body.slice(idx);
      return `${head}${sep}${sig}${tail}`;
    }
    return appendPlainTextSignature(body, identity, { separator: signatureSeparatorEnabled });
  }, [isReplyLike, signaturePosition, signatureSeparatorEnabled]);

  // Embed the signature once the identities are known. A re-opened draft
  // keeps whatever it already carries (#848).
  const signatureEmbeddedRef = React.useRef(false);
  const prevSignatureIdentityRef = React.useRef<Identity | null>(null);
  React.useEffect(() => {
    if (!primaryIdentity) return;
    if (!signatureEmbeddedRef.current) {
      signatureEmbeddedRef.current = true;
      prevSignatureIdentityRef.current = signatureIdentity;
      if (draft || !signatureIdentity) return;
      if (plainTextMode) {
        const next = placeSignaturePlain(latestRef.current.plainBody, signatureIdentity);
        setPlainBody(next);
        baselineRef.current = snapshotOf({
          to: initialTo, cc: initialCc, bcc: initialBcc, subject: initialSubject, body: next, attachments: initialAttachments,
        });
      } else {
        const sigHtml = buildEmbeddedSignatureHtml(signatureIdentity, { separator: signatureSeparatorEnabled });
        void (async () => {
          let live = latestRef.current.bodyHtml;
          try {
            live = (await editorRef.current?.getHtml()) ?? live;
          } catch { /* keep the last change message */ }
          if (containsEmbeddedSignature(live)) return;
          const next = placeSignatureHtml(live, sigHtml);
          setBodyHtml(next);
          editorRef.current?.setHtml(next);
          baselineRef.current = snapshotOf({
            to: initialTo, cc: initialCc, bcc: initialBcc, subject: initialSubject,
            body: placeSignatureHtml(initialBodyHtml, sigHtml), attachments: initialAttachments,
          });
        })();
      }
      return;
    }
    // Identity switch: swap the signature block, leaving the text alone.
    const prev = prevSignatureIdentityRef.current;
    if (prev?.id === signatureIdentity?.id) return;
    prevSignatureIdentityRef.current = signatureIdentity;
    if (plainTextMode) {
      setPlainBody((body) => {
        let stripped = body;
        if (prev && plainTextBodyHasSignature(body, prev)) {
          stripped = plainTextBodyWithoutSignature(body, prev);
        } else if (prev) {
          const old = getPlainTextSignature(prev);
          const marker = `${signatureSeparatorEnabled ? '\n\n-- \n' : '\n\n'}${old}`;
          if (old && body.includes(marker)) stripped = body.replace(marker, '');
        }
        return signatureIdentity ? placeSignaturePlain(stripped, signatureIdentity) : stripped;
      });
      return;
    }
    const sigHtml = signatureIdentity
      ? buildEmbeddedSignatureHtml(signatureIdentity, { separator: signatureSeparatorEnabled })
      : '';
    void (async () => {
      let live = latestRef.current.bodyHtml;
      try {
        live = (await editorRef.current?.getHtml()) ?? live;
      } catch { /* keep the last change message */ }
      const next = containsEmbeddedSignature(live)
        ? spliceSignature(live, sigHtml)
        : placeSignatureHtml(live, sigHtml);
      if (next !== live) {
        setBodyHtml(next);
        editorRef.current?.setHtml(next);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryIdentity?.id, signatureIdentity?.id]);

  // ── Outgoing message assembly ─────────────────────────────────────────

  const senderAddress = React.useCallback((identity: Identity): { from: EmailAddress; envelopeMailFrom?: string } => {
    const name = sanitizeDisplayName(identity.name);
    let from: EmailAddress;
    if (fromOverride?.email.trim()) {
      const overrideName = sanitizeDisplayName(fromOverride.name);
      from = overrideName ? { name: overrideName, email: fromOverride.email.trim() } : { email: fromOverride.email.trim() };
    } else {
      const email = subAddressTag ? generateSubAddress(identity.email, subAddressTag, subAddressDelimiter) : identity.email;
      from = name ? { name, email } : { email };
    }
    // A From that isn't the identity's own address still goes out through
    // the identity's envelope sender.
    const envelopeMailFrom = from.email.toLowerCase() !== identity.email.toLowerCase() ? identity.email : undefined;
    return { from, envelopeMailFrom };
  }, [fromOverride, subAddressTag, subAddressDelimiter]);

  const buildOutgoing = React.useCallback((identity: Identity, liveHtml: string, opts: { forDraft: boolean }): OutgoingEmail => {
    const { from, envelopeMailFrom } = senderAddress(identity);
    if (!messageIdRef.current) messageIdRef.current = generateMessageId(identity.email);

    let htmlBody: string | undefined;
    let textBody: string;
    let usedCids: string[] = [];
    if (plainTextMode) {
      textBody = plainBody;
    } else {
      const rewritten = rewriteInlineImages(liveHtml);
      usedCids = rewritten.usedCids;
      // Belt-and-suspenders sanitization: the editor uses execCommand which
      // can preserve pasted <script>/<style>/etc. Strip them before sending.
      const safeHtml = stripDangerousTags(opts.forDraft ? rewritten.html : stripEditorMarkers(rewritten.html));
      htmlBody = `<div>${safeHtml}</div>`;
      textBody = htmlToPlainText(safeHtml);
    }

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
    const outgoingAttachments = [...inlineFromBody, ...fileAttachments];

    // RFC 5322 §3.6.4: only replies continue the thread; a forward starts
    // a new one. The original's Message-ID (never its JMAP id) seeds
    // In-Reply-To, and References accumulates the chain (#234). A draft
    // keeps the headers it was saved with.
    const threading = replyTo && !draft && mode !== 'forward'
      ? computeReplyThreadingHeaders({ messageId: replyTo.messageId, references: replyTo.references })
      : draft && (draft.inReplyTo?.length || draft.references?.length)
        ? { inReplyTo: draft.inReplyTo ?? [], references: draft.references ?? draft.inReplyTo ?? [] }
        : null;

    const identityBcc = opts.forDraft ? [] : (identity.bcc ?? []).filter((r) => !!r.email);
    const bccAll = [...expandRecipients(finalBcc).map(toAddress), ...identityBcc];

    return {
      from: [from],
      to: expandRecipients(finalTo).map(toAddress),
      cc: finalCc.length ? expandRecipients(finalCc).map(toAddress) : undefined,
      bcc: bccAll.length ? bccAll : undefined,
      // The identity's Reply-To rides along on every message sent with it.
      replyTo: identity.replyTo?.length ? identity.replyTo : undefined,
      subject,
      htmlBody,
      textBody,
      attachments: outgoingAttachments.length ? outgoingAttachments : undefined,
      inReplyTo: threading?.inReplyTo,
      references: threading?.references,
      messageId: messageIdRef.current,
      requestReadReceipt,
      envelopeMailFrom,
    };
  }, [senderAddress, plainTextMode, plainBody, attachments, replyTo, draft, mode, finalTo, finalCc, finalBcc, subject, requestReadReceipt]);

  // Save one draft version (create, then destroy the previous one - #849).
  const saveDraftOnce = async (opts: { live: boolean }): Promise<string | null> => {
    const identity = primaryIdentity;
    if (!identity || !draftsMailbox || sendingRef.current) return draftIdRef.current;
    let html = latestRef.current.bodyHtml;
    if (opts.live && !plainTextMode) {
      try {
        html = (await editorRef.current?.getHtml()) ?? html;
      } catch { /* the last change message is the best we have */ }
      if (html !== latestRef.current.bodyHtml) setBodyHtml(html);
    }
    const snapshot = snapshotOf({
      to: finalTo, cc: finalCc, bcc: finalBcc, subject,
      body: plainTextMode ? plainBody : html, attachments,
    });
    if (snapshot === lastSavedRef.current) return draftIdRef.current;
    if (snapshot === baselineRef.current && !draftIdRef.current) return null;
    setDraftStatus('saving');
    try {
      const outgoing = buildOutgoing(identity, html, { forDraft: true });
      const id = await createDraft(outgoing, draftsMailbox.id, draftIdRef.current ?? undefined);
      draftIdRef.current = id;
      lastSavedRef.current = snapshot;
      lastSaveAtRef.current = Date.now();
      setDraftStatus('saved');
      return id;
    } catch (err) {
      setDraftStatus('failed');
      throw err;
    }
  };

  // Serialize saves: a save that starts while another is in flight waits
  // for it, so two versions can never race (#303).
  const saveDraft = (opts: { live: boolean }): Promise<string | null> => {
    const previous = inflightSaveRef.current;
    const promise = (async () => {
      if (previous) {
        try { await previous; } catch { /* reported by its own caller */ }
      }
      return saveDraftOnce(opts);
    })();
    inflightSaveRef.current = promise;
    void promise.finally(() => {
      if (inflightSaveRef.current === promise) inflightSaveRef.current = null;
    });
    return promise;
  };
  const saveDraftRef = React.useRef(saveDraft);
  saveDraftRef.current = saveDraft;

  // Debounced autosave: two seconds after the last change, rate-limited to
  // one save per `autoSaveDraftInterval`.
  React.useEffect(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!isDirty || !needsSave || !draftsMailbox || !primaryIdentity) return;
    const sinceLast = Date.now() - lastSaveAtRef.current;
    const wait = Math.max(2000, autoSaveDraftInterval - sinceLast);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      if (sendingRef.current || !latestRef.current.needsSave) return;
      // Live: the editor posts its content throttled, so read the DOM itself.
      saveDraftRef.current({ live: true }).catch((err) => {
        console.warn('[compose] autosave failed', err);
      });
    }, wait);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSnapshot, draftsMailbox?.id, primaryIdentity?.id]);

  // ── Close guard ──────────────────────────────────────────────────────

  // Why a draft can't be saved right now: the identities didn't load (e.g.
  // offline when the composer opened) or the account has no Drafts folder.
  const draftUnsavableReason = !primaryIdentity
    ? t('email_composer.save_failed_no_identity', 'Your sender identities could not be loaded, so this draft cannot be saved. Check your connection, or copy your text before closing.')
    : !draftsMailbox
      ? t('email_composer.save_failed_no_drafts', 'There is no Drafts folder to save this draft to.')
      : null;

  const saveAndClose = async (proceed: () => void) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    // Closing after a save that couldn't run would drop the text as if it
    // had been saved: stay open and say why.
    if (draftUnsavableReason) {
      Alert.alert(t('email_composer.save_failed', 'Failed to save'), draftUnsavableReason);
      return;
    }
    setSavingDraft(true);
    try {
      await saveDraft({ live: true });
      allowLeaveRef.current = true;
      proceed();
    } catch (err) {
      // The server refused the draft: keep the text on screen rather than
      // dropping it with nothing but an error (#702).
      Alert.alert(
        t('email_composer.save_failed', 'Failed to save'),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSavingDraft(false);
    }
  };

  const discardAndClose = (proceed: () => void) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    for (const a of attachments) a.abort?.abort();
    // A draft this session created by autosave goes with the discard; a
    // re-opened draft keeps its last saved version.
    const autosaved = draftIdRef.current;
    if (autosaved && !draft) {
      void (async () => {
        try { await inflightSaveRef.current; } catch { /* ignore */ }
        const id = draftIdRef.current ?? autosaved;
        destroyEmails([id]).catch((err) => console.warn('[compose] discard failed', err));
      })();
    }
    allowLeaveRef.current = true;
    proceed();
  };

  const showCloseDialog = (proceed: () => void) => {
    if (draftUnsavableReason) {
      Alert.alert(
        t('email_composer.discard_draft_title', 'Discard draft?'),
        draftUnsavableReason,
        [
          { text: t('email_composer.cancel', 'Cancel'), style: 'cancel' },
          { text: t('email_composer.discard', 'Discard'), style: 'destructive', onPress: () => discardAndClose(proceed) },
        ],
      );
      return;
    }
    Alert.alert(
      t('email_composer.close_draft_title', 'Save or discard draft?'),
      t('email_composer.close_draft_message', 'You have unsaved changes. Would you like to save this as a draft or discard it?'),
      [
        { text: t('email_composer.cancel', 'Cancel'), style: 'cancel' },
        { text: t('email_composer.discard', 'Discard'), style: 'destructive', onPress: () => discardAndClose(proceed) },
        { text: t('email_composer.save_draft', 'Save Draft'), onPress: () => { void saveAndClose(proceed); } },
      ],
    );
  };

  // The OS back gesture / hardware back goes through the same guard as the
  // header X. `usePreventRemove` (not a bare `beforeRemove` listener) also
  // blocks the iOS modal swipe-down, which is dismissed natively otherwise.
  // Re-dispatching the intercepted action doesn't come back here.
  usePreventRemove(isDirty || needsSave, ({ data }) => {
    if (allowLeaveRef.current) {
      navigation.dispatch(data.action);
      return;
    }
    showCloseDialog(() => navigation.dispatch(data.action));
  });

  const onClose = () => {
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
    const removed = attachments.find((a) => a.localId === localId);
    removed?.abort?.abort();
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));
    if (removed?.inline && removed.cid) {
      inlineRegistryRef.current.delete(removed.cid);
      // Strip the editor's <img data-cid="…"> for this cid from the live DOM
      // (not the last change message, which can lag typing).
      const escCid = removed.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`<img\\b[^>]*\\sdata-cid=("${escCid}"|'${escCid}')[^>]*>`, 'gi');
      void (async () => {
        let live = latestRef.current.bodyHtml;
        try {
          live = (await editorRef.current?.getHtml()) ?? live;
        } catch { /* fall back */ }
        const stripped = live.replace(re, '');
        if (stripped !== live) {
          setBodyHtml(stripped);
          editorRef.current?.setHtml(stripped);
        }
      })();
    }
  };

  // Server limits: refuse files the upload endpoint would reject and keep
  // the per-message attachment total under the mail capability's ceiling.
  const checkAttachmentSize = (size: number, inline: boolean): boolean => {
    const maxUpload = jmapClient.getMaxSizeUpload();
    if (maxUpload && size > maxUpload) {
      Alert.alert(
        t('email_composer.attach', 'Attach'),
        t('email_composer.attachment_too_large', 'This file is larger than the server allows ({size} > {max}).', {
          size: formatBytes(size), max: formatBytes(maxUpload),
        }),
      );
      return false;
    }
    const maxTotal = jmapClient.getMaxSizeAttachmentsPerEmail();
    if (!inline && maxTotal) {
      const total = attachments.filter((a) => !a.inline && !a.error).reduce((n, a) => n + a.size, 0) + size;
      if (total > maxTotal) {
        Alert.alert(
          t('email_composer.attach', 'Attach'),
          t('email_composer.attachments_too_large_total', 'The attachments would exceed the {max} this server allows per message.', {
            max: formatBytes(maxTotal),
          }),
        );
        return false;
      }
    }
    return true;
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
      abort: new AbortController(),
    };
    setAttachments((prev) => [...prev, entry]);
    if (asset.inline && asset.cid) inlineRegistryRef.current.set(asset.cid, entry);
    return entry;
  };

  const startUpload = async (entry: AttachmentEntry) => {
    try {
      const { blobId, size, type } = await uploadBlob(entry.uri, entry.type, {
        signal: entry.abort?.signal,
        onProgress: (sent, total) => {
          if (total > 0) updateAttachment(entry.localId, { progress: Math.min(1, sent / total) });
        },
      });
      updateAttachment(entry.localId, {
        blobId,
        type: type || entry.type,
        size: size || entry.size,
        uploading: false,
        progress: undefined,
        abort: undefined,
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return; // removed by the user
      const message = e instanceof Error ? e.message : t('email_composer.upload_failed_short', 'Upload failed');
      updateAttachment(entry.localId, { uploading: false, progress: undefined, error: message });
      Alert.alert(
        t('email_composer.upload_failed', 'Failed to upload {filename}', { filename: entry.name }),
        message,
      );
    }
  };

  const addFileAsset = (asset: { name: string; type: string; size: number; uri: string }) => {
    if (!checkAttachmentSize(asset.size, false)) return;
    void startUpload(addUploadEntry({ ...asset, inline: false }));
  };

  // Files shared into the app (Android SEND / iOS share sheet) start uploading
  // right away.
  React.useEffect(() => {
    if (!prefillAttachments?.length) return;
    for (const a of prefillAttachments) {
      addFileAsset({ name: a.name, type: a.type || 'application/octet-stream', size: a.size ?? 0, uri: a.uri });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickPhotoAttachments = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t('email_composer.attach', 'Attach'),
        t('email_composer.permission_photos', 'Photo library permission is required to attach images.'),
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
      addFileAsset({
        name: fallbackName,
        type: asset.mimeType ?? 'application/octet-stream',
        size: asset.fileSize ?? 0,
        uri: asset.uri,
      });
    }
  };

  const takePhotoAttachment = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t('email_composer.attach', 'Attach'),
        t('email_composer.permission_camera', 'Camera permission is required to take a photo.'),
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.9, exif: false });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const mime = asset.mimeType ?? 'image/jpeg';
    addFileAsset({
      name: asset.fileName || `photo-${Date.now()}.${mime.split('/')[1] ?? 'jpg'}`,
      type: mime,
      size: asset.fileSize ?? 0,
      uri: asset.uri,
    });
  };

  const pickFileAttachments = async () => {
    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/cancel/i.test(message)) return;
      Alert.alert(t('email_composer.attach', 'Attach'), message);
      return;
    }
    if (result.canceled) return;
    for (const picked of result.assets) {
      addFileAsset({
        name: picked.name || `attachment-${Date.now()}`,
        type: picked.mimeType || 'application/octet-stream',
        size: picked.size ?? 0,
        uri: picked.uri,
      });
    }
  };

  const [attachMenuOpen, setAttachMenuOpen] = React.useState(false);
  const attachOptions: SheetOption[] = [
    { label: t('email_composer.attach_photos', 'Photos & Videos'), onPress: () => { void pickPhotoAttachments(); } },
    { label: t('email_composer.attach_camera', 'Camera'), onPress: () => { void takePhotoAttachment(); } },
    { label: t('email_composer.attach_files', 'Files'), onPress: () => { void pickFileAttachments(); } },
  ];

  const insertInlineImages = async (assets: Array<{ uri: string; mimeType?: string | null; fileName?: string | null; fileSize?: number | null }>) => {
    for (const asset of assets) {
      const mime = asset.mimeType ?? 'image/jpeg';
      const fallbackName = asset.fileName || `image-${Date.now()}.${mime.split('/')[1] ?? 'jpg'}`;
      if (!checkAttachmentSize(asset.fileSize ?? 0, true)) continue;
      const cid = genCid();
      // Read the picked image as a data URL so it shows up immediately in the
      // editor. At send time the data URL is rewritten to `cid:<id>` and the
      // matching inline part is added via the registry.
      const dataUrl = await readUriAsDataUrl(asset.uri, mime);
      if (!dataUrl) {
        Alert.alert(t('email_composer.attach', 'Attach'), t('email_composer.image_load_failed', 'Could not load image'));
        continue;
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
    }
  };

  const insertInlineImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t('email_composer.attach', 'Attach'),
        t('email_composer.permission_photos', 'Photo library permission is required to attach images.'),
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 0.9,
      exif: false,
    });
    if (result.canceled || result.assets.length === 0) return;
    await insertInlineImages(result.assets);
  };

  // Open a chip: local files straight from their URI, server blobs after a
  // download into the cache.
  const previewAttachment = async (entry: AttachmentEntry) => {
    try {
      let uri = entry.uri;
      if (!uri && entry.blobId) {
        const buf = await jmapClient.fetchBlobArrayBuffer(entry.blobId, entry.name, entry.type);
        const dir = FileSystem.cacheDirectory ?? '';
        uri = `${dir}${entry.localId}-${entry.name.replace(/[^\w.-]+/g, '_')}`;
        await FileSystem.writeAsStringAsync(uri, bytesToBase64(new Uint8Array(buf)), {
          encoding: FileSystem.EncodingType.Base64,
        });
      }
      if (!uri) return;
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: entry.type, dialogTitle: entry.name });
      }
    } catch (err) {
      Alert.alert(t('email_composer.attach', 'Attach'), err instanceof Error ? err.message : String(err));
    }
  };

  // ── Format ───────────────────────────────────────────────────────────

  // Switch this one message between rich and plain text (#1022). The body is
  // converted in place and the embedded signature survives in the target
  // format (lib/compose-format). Formatting is dropped going to plain text
  // and doesn't come back on a second switch; images the user inserted stay
  // on as ordinary attachments rather than silently not being sent.
  const togglePlainTextMode = async () => {
    const separator = signatureSeparatorEnabled;
    if (plainTextMode) {
      const next = plainComposeBodyToHtml(plainBody, signatureIdentity, { separator });
      setBodyHtml(next);
      setEditorSeedHtml(next);
      setPlainTextMode(false);
      return;
    }
    let html = latestRef.current.bodyHtml;
    try {
      html = (await editorRef.current?.getHtml()) ?? html;
    } catch { /* the last change message is the best we have */ }
    setPlainBody(htmlComposeBodyToPlainText(html, signatureIdentity, { separator }));
    setAttachments((prev) => (prev.some((a) => a.inline) ? prev.map((a) => (a.inline ? { ...a, inline: false } : a)) : prev));
    setPlainTextMode(true);
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

  // ── Colour / table ───────────────────────────────────────────────────
  const [colorTarget, setColorTarget] = React.useState<'text' | 'background' | null>(null);
  const [tableMenuOpen, setTableMenuOpen] = React.useState(false);
  const insertTable = (rows: number, cols: number) => {
    const cell = '<td style="border:1px solid #cccccc;padding:6px;min-width:40px">&nbsp;</td>';
    const row = `<tr>${cell.repeat(cols)}</tr>`;
    editorRef.current?.insertHtml(
      `<table style="border-collapse:collapse;width:100%"><tbody>${row.repeat(rows)}</tbody></table><p><br></p>`,
    );
  };
  const tableOptions: SheetOption[] = [
    { label: '2 × 2', onPress: () => insertTable(2, 2) },
    { label: '3 × 3', onPress: () => insertTable(3, 3) },
    { label: '4 × 3', onPress: () => insertTable(4, 3) },
  ];

  // ── Templates ────────────────────────────────────────────────────────
  const [templateSheetOpen, setTemplateSheetOpen] = React.useState(false);
  const [placeholderPrompt, setPlaceholderPrompt] = React.useState<{
    template: EmailTemplate;
    auto: Record<string, string>;
    values: Record<string, string>;
  } | null>(null);

  const insertPlainText = (text: string) => {
    const sel = plainSelectionRef.current;
    setPlainBody((prev) => {
      const start = sel ? Math.min(sel.start, prev.length) : prev.length;
      const end = sel ? Math.min(sel.end, prev.length) : prev.length;
      return prev.slice(0, start) + text + prev.slice(end);
    });
  };

  const applyTemplate = (template: EmailTemplate, values: Record<string, string>) => {
    const hasValues = Object.keys(values).length > 0;
    const filledSubject = hasValues ? substitutePlaceholders(template.subject, values) : template.subject;
    const filledBody = hasValues ? substitutePlaceholders(template.body, values) : template.body;
    // An empty template subject must not wipe one the user typed (#540).
    if (filledSubject && !subject.trim()) setSubject(filledSubject);
    if (plainTextMode) {
      insertPlainText(template.isHTML ? htmlToPlainText(filledBody) : filledBody);
    } else {
      // Inserted at the caret so it lands after any text already typed and
      // leaves the signature / quote alone (#539/#540).
      editorRef.current?.insertHtml(templateBodyToHtml({ body: filledBody, isHTML: template.isHTML }));
    }
    const addChips = (field: Field, list?: string[]) => {
      if (!list?.length) return;
      const chips = list.map(parseRecipient).map(fromParsed).filter(chipIsValid);
      if (!chips.length) return;
      setterFor(field)((prev) => {
        const existing = new Set(prev.map((r) => r.email.toLowerCase()));
        return [...prev, ...chips.filter((r) => !existing.has(r.email.toLowerCase()))];
      });
      if (field === 'cc') setCcVisible(true);
      if (field === 'bcc') { setCcVisible(true); setBccVisible(true); }
    };
    addChips('to', template.defaultRecipients?.to);
    addChips('cc', template.defaultRecipients?.cc);
    addChips('bcc', template.defaultRecipients?.bcc);
    if (template.identityId && identities.some((i) => i.id === template.identityId)) {
      setSelectedIdentityId(template.identityId);
    }
  };

  const onPickTemplate = (template: EmailTemplate) => {
    const placeholders = getPlaceholdersFromTemplate(template);
    const auto = getAutoFilledPlaceholders({
      senderName: primaryIdentity?.name || undefined,
      recipientName: finalTo[0]?.name || undefined,
      locale,
    });
    const missing = placeholders.filter((p) => auto[p] === undefined);
    if (missing.length === 0) {
      applyTemplate(template, placeholders.length ? auto : {});
      return;
    }
    setPlaceholderPrompt({
      template,
      auto,
      values: Object.fromEntries(missing.map((m) => [m, ''])),
    });
  };

  // ── From options (sub-address tag / override) ────────────────────────
  const [fromOptionsOpen, setFromOptionsOpen] = React.useState(false);
  const [tagDraft, setTagDraft] = React.useState('');
  const [overrideEnabled, setOverrideEnabled] = React.useState(false);
  const [overrideName, setOverrideName] = React.useState('');
  const [overrideEmail, setOverrideEmail] = React.useState('');
  const openFromOptions = () => {
    setTagDraft(subAddressTag);
    setOverrideEnabled(!!fromOverride);
    setOverrideName(fromOverride?.name ?? primaryIdentity?.name ?? '');
    setOverrideEmail(fromOverride?.email ?? primaryIdentity?.email ?? '');
    setFromOptionsOpen(true);
  };
  const tagError = tagDraft ? getTagValidationError(tagDraft) : null;
  const tagSuggestions = React.useMemo(() => {
    const domains = finalTo.flatMap((r) => (r.group ? r.group.members.map((m) => m.email) : [r.email]))
      .map(extractDomain)
      .filter((d): d is string => !!d);
    const out: string[] = [];
    for (const d of domains) for (const s of suggestTagsForDomain(d)) if (!out.includes(s)) out.push(s);
    return out.slice(0, 5);
  }, [finalTo]);
  const applyFromOptions = () => {
    if (overrideEnabled) {
      const email = overrideEmail.trim();
      if (!isValidEmail(email)) {
        Alert.alert(t('email_composer.from_override.email_label', 'From email address'), t('identities.form.email_invalid', 'Please enter a valid email address'));
        return;
      }
      setFromOverride({ name: overrideName.trim(), email });
      setSubAddressTag('');
    } else {
      setFromOverride(null);
      if (tagDraft && tagError) return;
      setSubAddressTag(tagDraft.trim());
    }
    setFromOptionsOpen(false);
  };

  // ── Send ─────────────────────────────────────────────────────────────

  // Catch the classic "I forgot the attachment" footgun. Only file attachments
  // count - inline images don't satisfy the user's intent of attaching a file.
  // Only the text the user wrote is scanned, not the quoted original (#570).
  // Returns true if it's safe to proceed, false if the user cancelled.
  const passesAttachmentReminder = async (body: string): Promise<boolean> => {
    if (!attachmentReminderEnabled) return true;
    const hasFileAttachment = attachments.some(
      (a) => !a.inline && a.blobId && !a.error,
    );
    if (hasFileAttachment) return true;
    const authored = extractUserAuthoredText(body, {
      plainTextMode,
      forwardedSeparator: quoteLabels.forwardedSeparator,
    });
    const haystack = `${subject}\n${authored}`.toLowerCase();
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
          { keyword: matchedKeyword },
        ),
        [
          { text: t('email_composer.cancel', 'Cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: t('email_composer.send', 'Send'), onPress: () => resolve(true) },
        ],
      );
    });
  };

  // Confirm an empty subject instead of silently blocking Send (#684).
  const passesEmptySubjectCheck = (): Promise<boolean> => {
    if (subject.trim() || !emptySubjectWarningEnabled) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      Alert.alert(
        t('email_composer.empty_subject.title', 'Send without a subject?'),
        t('email_composer.empty_subject.message', 'This message has no subject. Send it anyway?'),
        [
          { text: t('email_composer.empty_subject.back', 'Back to editing'), style: 'cancel', onPress: () => resolve(false) },
          {
            text: t('email_composer.empty_subject.dont_ask_again', "Don't ask again"),
            onPress: () => { updateSetting('emptySubjectWarningEnabled', false); resolve(true); },
          },
          { text: t('email_composer.empty_subject.send_anyway', 'Send anyway'), onPress: () => resolve(true) },
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
  // supports it (capped at its hold limit), otherwise sends immediately.
  const onSend = () => {
    const holdFor = jmapClient.undoSendHold(sendDelaySeconds);
    void performSend(holdFor);
  };

  const onScheduleConfirm = (date: Date) => {
    const holdFor = resolveHoldForScheduledAt(date);
    if (holdFor == null) return;
    setScheduleSheetOpen(false);
    void performSend(holdFor, date);
  };

  const formatWhen = (date: Date) => formatQuoteDate(date.toISOString(), timeFormat, locale);

  const schedulePresets = React.useMemo(() => {
    const now = new Date();
    const inHours = (h: number) => new Date(now.getTime() + h * 3600 * 1000);
    const tomorrowMorning = new Date(now);
    tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
    tomorrowMorning.setHours(8, 0, 0, 0);
    // Only offer times within the server's hold limit.
    const maxMs = jmapClient.getMaxDelayedSend() * 1000;
    return [
      { label: t('email_composer.schedule_in_1h', 'In 1 hour'), date: inHours(1) },
      { label: t('email_composer.schedule_in_3h', 'In 3 hours'), date: inHours(3) },
      { label: t('email_composer.schedule_tomorrow_morning', 'Tomorrow morning'), date: tomorrowMorning },
    ].filter((preset) => preset.date.getTime() - now.getTime() <= maxMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, scheduleSheetOpen]);

  const startCustomPicker = () => {
    // An hour ahead, or the latest time the server can hold it if sooner.
    const latest = jmapClient.latestHoldDate()?.getTime() ?? Infinity;
    customDraftRef.current = new Date(Math.min(Date.now() + 3600 * 1000, latest));
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

  // Synchronous re-entry guard: `sending` state only flips after a few
  // awaits below, so two quick taps could both pass `canSend` and submit
  // twice. The same flag pauses the autosave while a send is in flight.
  const performSend = async (holdForSeconds?: number, scheduledAt?: Date) => {
    if (!canSend || !primaryIdentity || !sentMailbox) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      await performSendInner(holdForSeconds, scheduledAt);
    } finally {
      sendingRef.current = false;
    }
  };

  const performSendInner = async (holdForSeconds?: number, scheduledAt?: Date) => {
    if (!primaryIdentity || !sentMailbox) return;

    // Read the body straight from the editor DOM at send time. The `change`
    // messages that feed `bodyHtml` are async and best-effort — trusting them
    // here once shipped replies with the typed text silently missing when the
    // page script had died (issue #9). If the editor doesn't answer we abort
    // loudly rather than send possibly-stale content.
    let liveBodyHtml = bodyHtml;
    if (!plainTextMode) {
      try {
        liveBodyHtml = (await editorRef.current?.getHtml()) ?? bodyHtml;
      } catch {
        Alert.alert(
          t('email_composer.send_failed', 'Send failed'),
          t(
            'email_composer.editor_unavailable',
            'Could not read the message content. Copy your text, then close and reopen the composer.',
          ),
        );
        return;
      }
      if (liveBodyHtml !== bodyHtml) setBodyHtml(liveBodyHtml);
    }

    if (!(await passesEmptySubjectCheck())) return;
    if (!(await passesAttachmentReminder(plainTextMode ? plainBody : liveBodyHtml))) return;

    // Autosave must not race the send: cancel a scheduled save and let an
    // in-flight one finish so its version can be destroyed after the send.
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (inflightSaveRef.current) {
      try { await inflightSaveRef.current; } catch { /* stale version stays; cleaned up below */ }
    }

    setSending(true);
    try {
      const outgoing = buildOutgoing(primaryIdentity, liveBodyHtml, { forDraft: false });
      const result = await sendEmail(
        outgoing,
        primaryIdentity.id,
        sentMailbox.id,
        holdForSeconds,
        { draftsMailboxId: draftsMailbox?.id, draftId: draftIdRef.current ?? undefined },
      );
      draftIdRef.current = null;
      lastSavedRef.current = null;
      if (result.filingWarning) {
        console.warn('[compose] post-send filing warning:', result.filingWarning);
      }
      // Flag the original so the list shows the reply/forward arrow; best
      // effort - the message already left.
      if (replyTo?.originalEmailId) {
        void patchKeywordsForEmails(
          [replyTo.originalEmailId],
          { [mode === 'forward' ? '$forwarded' : '$answered']: true },
          replyTo.jmapAccountId,
        ).catch(() => undefined);
      }
      // People you reply to are people you trust: allow their remote content
      // from now on (webmail 1.5.x).
      if (isReplyLike && mode !== 'forward') {
        const settings = useSettingsStore.getState();
        const contacts = useContactsStore.getState();
        for (const r of [...outgoing.to, ...(outgoing.cc ?? [])]) {
          settings.addTrustedSender(r.email);
          if (trustedSendersAddressBook) {
            contacts.addToTrustedSendersBook(r.name ? `${r.name} <${r.email}>` : r.email).catch(() => undefined);
          }
        }
      }
      if (scheduledAt && result.scheduled) {
        // Confirm an explicit "send later" so the user knows it didn't go out now.
        const when = result.sendAt ? new Date(result.sendAt) : scheduledAt;
        Alert.alert(
          t('email_composer.scheduled_title', 'Scheduled'),
          t('email_composer.scheduled_body', 'Your message will be sent at {time}.', { time: formatWhen(when) }),
        );
      } else if (result.scheduled) {
        // Undo-send window: the undo bar offers Undo / Send now.
        useSendUndoStore.getState().recordHeldSend(result, holdForSeconds, {
          identityId: primaryIdentity.id,
          from: outgoing.from,
          to: [...outgoing.to, ...(outgoing.cc ?? []), ...(outgoing.bcc ?? [])],
        });
      } else {
        // Held sends get the undo bar instead (webmail b03a0c1d).
        toast.success(t('notifications.email_sent', 'Email sent successfully'));
      }
      allowLeaveRef.current = true;
      navigation.goBack();
    } catch (e) {
      if (e instanceof RequestTimeoutError) {
        // The request may have reached the server; a blind retry would send
        // the message twice (#702).
        Alert.alert(
          t('email_composer.send_timeout_title', 'No answer from the server'),
          t(
            'email_composer.send_timeout_body',
            'The message may already have gone out. Check your Sent folder before sending it again.',
          ),
        );
        return;
      }
      if (e instanceof ScheduleTooLateError) {
        // The server refused the hold; the pickers now only offer times
        // within the limit it named.
        Alert.alert(
          t('email_composer.schedule_too_late_title', 'Too far ahead'),
          t('email_composer.schedule_too_late_body', 'That is later than this server allows. Pick an earlier time.'),
        );
        return;
      }
      Alert.alert(
        t('email_composer.send_failed', 'Send failed'),
        e instanceof Error ? e.message : t('notifications.error_sending', 'Failed to send email'),
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

  const fromDisplay = React.useMemo(() => {
    if (!primaryIdentity) return identityError ? t('email_composer.identity_unavailable', 'Identity unavailable') : t('common.loading', 'Loading...');
    const { from } = senderAddress(primaryIdentity);
    return from.name ? `${from.name} <${from.email}>` : from.email;
  }, [primaryIdentity, identityError, senderAddress, t]);

  const draftStatusText =
    savingDraft || draftStatus === 'saving' ? t('email_composer.saving', 'Saving...')
    : draftStatus === 'saved' ? t('email_composer.draft_saved', 'Draft saved')
    : draftStatus === 'failed' ? t('email_composer.save_failed', 'Failed to save')
    : '';

  const renderRecipientField = (field: Field, label: string, placeholder: string, zIndex: number) => {
    const list = field === 'to' ? toRecipients : field === 'cc' ? ccRecipients : bccRecipients;
    const input = inputFor(field);
    const setInput = inputSetterFor(field);
    const invalidInput = typedRecipients[field].invalid.length > 0 && !typedRecipients[field].valid.length && input.trim().length > 0 && activeField !== field;
    return (
      <View style={[styles.fieldRow, { zIndex }]}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <View style={styles.recipientField}>
          {list.map((r, i) => (
            <RecipientChip
              key={`${r.email}-${i}`}
              recipient={r}
              invalid={!chipIsValid(r)}
              onRemove={() => removeChip(field, i)}
              onLongPress={() => setChipMenu({ field, index: i })}
            />
          ))}
          <TextInput
            style={[styles.recipientInput, invalidInput && styles.recipientInputInvalid]}
            placeholder={placeholder}
            placeholderTextColor={c.textMuted}
            value={input}
            onChangeText={(text) => {
              // A separator ends the entry: commit immediately so a pasted
              // list turns into chips as it lands.
              setInput(text);
              if (/[,;\n]$/.test(text) && text.trim().length > 1) {
                const { valid, invalid } = splitPastedRecipients(text, Array.from(alreadySelected));
                if (valid.length) {
                  setterFor(field)((prev) => [...prev, ...valid.map(fromParsed)]);
                  setInput(invalid.join(' '));
                }
              }
            }}
            onFocus={() => setActiveField(field)}
            onBlur={() => {
              setTimeout(() => {
                if (!isPickingSuggestion.current) {
                  addTyped(field);
                }
                setActiveField((f) => (f === field ? null : f));
                isPickingSuggestion.current = false;
              }, 200);
            }}
            onSubmitEditing={() => addTyped(field)}
            blurOnSubmit={false}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        {activeField === field && suggestions.length > 0 && (
          <SuggestionList
            suggestions={suggestions}
            onPick={pickSuggestion}
            onPressIn={() => {
              isPickingSuggestion.current = true;
            }}
          />
        )}
        {field === 'to' && !ccVisible && (
          <Pressable onPress={() => setCcVisible(true)} style={styles.ccToggle}>
            <Text style={styles.ccToggleText}>{t('email_composer.cc', 'Cc')}</Text>
          </Pressable>
        )}
        {field === 'cc' && !bccVisible && (
          <Pressable onPress={() => setBccVisible(true)} style={styles.ccToggle}>
            <Text style={styles.ccToggleText}>{t('email_composer.bcc', 'Bcc')}</Text>
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={onClose}
          style={styles.headerBtn}
          disabled={savingDraft}
          accessibilityRole="button"
          accessibilityLabel={t('common.close', 'Close')}
        >
          {savingDraft ? <ActivityIndicator size="small" color={c.text} /> : <X size={22} color={c.text} />}
        </Pressable>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {t(titleKey, mode === 'forward' ? 'Forward' : mode === 'replyAll' ? 'Reply All' : replyTo ? 'Reply' : 'New Message')}
          </Text>
          {!!draftStatusText && (
            <Text style={styles.headerSubtitle} numberOfLines={1}>{draftStatusText}</Text>
          )}
        </View>
        <View style={styles.headerRight}>
          <Pressable
            onPress={() => setAttachMenuOpen(true)}
            style={styles.headerBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('email_composer.attach', 'Attach')}
          >
            <Paperclip size={20} color={c.text} />
          </Pressable>
          {/* Only offer scheduling when the server can hold the message (webmail parity). */}
          {jmapClient.hasDelayedSend() && (
            <Pressable
              onPress={() => setScheduleSheetOpen(true)}
              style={styles.headerBtn}
              hitSlop={8}
              disabled={!canSend}
              accessibilityRole="button"
              accessibilityLabel={t('email_composer.schedule_send', 'Schedule send')}
            >
              <Clock size={20} color={canSend ? c.text : c.textMuted} />
            </Pressable>
          )}
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
          keyboardShouldPersistTaps="always"
          contentContainerStyle={styles.scrollContent}
        >
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>{t('email_composer.from', 'From')}</Text>
            <Pressable
              onPress={openIdentityPicker}
              onLongPress={openFromOptions}
              disabled={identities.length <= 1 && !primaryIdentity}
              style={styles.fieldContent}
            >
              <Text style={[styles.fromText, !!fromOverride && styles.fromTextOverride]} numberOfLines={1}>
                {fromDisplay}
              </Text>
              {identities.length > 1 && <ChevronDown size={14} color={c.textMuted} />}
            </Pressable>
            {!!primaryIdentity && (
              <Pressable
                onPress={openFromOptions}
                hitSlop={8}
                style={styles.fromOptionsBtn}
                accessibilityRole="button"
                accessibilityLabel={t('email_composer.from_options', 'Sender options')}
              >
                <Tag size={16} color={subAddressTag || fromOverride ? c.primary : c.textMuted} />
              </Pressable>
            )}
          </View>

          {renderRecipientField('to', t('email_composer.to', 'To'), t('email_composer.to_placeholder', 'Recipient email addresses'), 6)}
          {ccVisible && renderRecipientField('cc', t('email_composer.cc', 'Cc'), t('email_composer.cc_placeholder', 'Cc recipients'), 5)}
          {bccVisible && renderRecipientField('bcc', t('email_composer.bcc', 'Bcc'), t('email_composer.bcc_placeholder', 'Bcc recipients'), 4)}

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
                  onPress={() => { void previewAttachment(a); }}
                />
              ))}
            </View>
          )}

          {plainTextMode ? (
            <TextInput
              style={styles.plainEditor}
              multiline
              value={plainBody}
              onChangeText={setPlainBody}
              onSelectionChange={(e) => { plainSelectionRef.current = e.nativeEvent.selection; }}
              placeholder={t('email_composer.body_placeholder', 'Write your message...')}
              placeholderTextColor={c.textMuted}
              textAlignVertical="top"
              autoCorrect
            />
          ) : (
            <RichTextEditor
              ref={editorRef}
              initialHtml={editorSeedHtml}
              blockRemoteImages={blockRemoteImages}
              placeholder={t('email_composer.body_placeholder', 'Write your message...')}
              onChange={setBodyHtml}
              onSelectionChange={setSelState}
            />
          )}
        </ScrollView>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.formatBar}
          contentContainerStyle={styles.formatActions}
          keyboardShouldPersistTaps="always"
        >
          <ToolbarButton onPress={() => setTemplateSheetOpen(true)}
            icon={<LayoutTemplate size={18} color={c.textSecondary} />} />
          <ToolbarButton active={requestReadReceipt} onPress={() => setRequestReadReceipt((v) => !v)}
            icon={<MailCheck size={18} color={requestReadReceipt ? c.primary : c.textSecondary} />} />
          <ToolbarButton active={plainTextMode} onPress={() => { void togglePlainTextMode(); }}
            label={plainTextMode
              ? t('email_composer.format_rich_text', 'Switch to rich text (HTML)')
              : t('email_composer.format_plain_text', 'Switch to plain text')}
            icon={<Type size={18} color={plainTextMode ? c.primary : c.textSecondary} />} />

          {!plainTextMode && (
            <>
              <View style={styles.formatSep} />

              <ToolbarButton active={selState.bold} onPress={() => editorRef.current?.exec('bold')}
                icon={<Bold size={18} color={selState.bold ? c.primary : c.textSecondary} />} />
              <ToolbarButton active={selState.italic} onPress={() => editorRef.current?.exec('italic')}
                icon={<Italic size={18} color={selState.italic ? c.primary : c.textSecondary} />} />
              <ToolbarButton active={selState.underline} onPress={() => editorRef.current?.exec('underline')}
                icon={<Underline size={18} color={selState.underline ? c.primary : c.textSecondary} />} />
              <ToolbarButton active={selState.strikeThrough} onPress={() => editorRef.current?.exec('strikeThrough')}
                icon={<Strikethrough size={18} color={selState.strikeThrough ? c.primary : c.textSecondary} />} />
              <ToolbarButton onPress={() => setColorTarget('text')}
                label={t('email_composer.toolbar.text_color', 'Text color')}
                icon={<Palette size={18} color={c.textSecondary} />} />
              <ToolbarButton onPress={() => setColorTarget('background')}
                label={t('email_composer.toolbar.background_color', 'Background color')}
                icon={<Highlighter size={18} color={c.textSecondary} />} />

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
              <ToolbarButton onPress={() => setTableMenuOpen(true)}
                icon={<Table size={18} color={c.textSecondary} />} />

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
            </>
          )}
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

      {/* Text / background colour palette */}
      <Modal visible={!!colorTarget} transparent animationType="fade" onRequestClose={() => setColorTarget(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setColorTarget(null)}>
          <Pressable style={styles.scheduleCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>
              {colorTarget === 'background'
                ? t('email_composer.toolbar.background_color', 'Background color')
                : t('email_composer.toolbar.text_color', 'Text color')}
            </Text>
            <View style={styles.swatchRow}>
              {TEXT_COLORS.map((color) => (
                <Pressable
                  key={color}
                  accessibilityLabel={color}
                  onPress={() => {
                    setColorTarget(null);
                    editorRef.current?.exec(colorTarget === 'background' ? `hiliteColor:${color}` : `foreColor:${color}`);
                  }}
                  style={[styles.swatch, { backgroundColor: color }]}
                />
              ))}
            </View>
            {colorTarget === 'background' && (
              <Pressable
                style={styles.scheduleRow}
                onPress={() => { setColorTarget(null); editorRef.current?.exec('hiliteColor:transparent'); }}
              >
                <RemoveFormatting size={16} color={c.textSecondary} />
                <Text style={styles.scheduleRowLabel}>
                  {t('email_composer.toolbar.remove_background_color', 'Remove background color')}
                </Text>
              </Pressable>
            )}
            <Pressable style={styles.scheduleCancel} onPress={() => setColorTarget(null)}>
              <Text style={styles.modalCancelText}>{t('email_composer.cancel', 'Cancel')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <OptionsSheet
        visible={tableMenuOpen}
        title={t('email_composer.toolbar.table', 'Table')}
        options={tableOptions}
        onClose={() => setTableMenuOpen(false)}
        cancelLabel={t('email_composer.cancel', 'Cancel')}
      />

      <OptionsSheet
        visible={attachMenuOpen}
        title={t('email_composer.attach', 'Attach')}
        options={attachOptions}
        onClose={() => setAttachMenuOpen(false)}
        cancelLabel={t('email_composer.cancel', 'Cancel')}
      />

      <OptionsSheet
        visible={!!chipMenu}
        title={chipMenuRecipient ? (chipMenuRecipient.group ? chipMenuRecipient.name : (chipMenuRecipient.name ? `${chipMenuRecipient.name} <${chipMenuRecipient.email}>` : chipMenuRecipient.email)) : undefined}
        options={chipMenuOptions}
        onClose={() => setChipMenu(null)}
        cancelLabel={t('email_composer.cancel', 'Cancel')}
      />

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
            {schedulePresets.map((preset) => (
              <Pressable
                key={preset.label}
                style={styles.scheduleRow}
                onPress={() => onScheduleConfirm(preset.date)}
              >
                <Clock size={16} color={c.textSecondary} />
                <Text style={styles.scheduleRowLabel}>{preset.label}</Text>
                <Text style={styles.scheduleRowTime}>{formatWhen(preset.date)}</Text>
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
                maximumDate={jmapClient.latestHoldDate()}
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
          maximumDate={customStage === 'date' ? jmapClient.latestHoldDate() : undefined}
          onChange={onCustomPickerChange}
        />
      )}

      {/* Template placeholders */}
      <Modal
        visible={!!placeholderPrompt}
        transparent
        animationType="fade"
        onRequestClose={() => setPlaceholderPrompt(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('templates.fill_placeholders', 'Fill Placeholder Values')}</Text>
            <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
              {Object.keys(placeholderPrompt?.values ?? {}).map((name) => (
                <View key={name} style={{ gap: 4, marginBottom: spacing.sm }}>
                  <Text style={styles.modalLabel}>
                    {t(`templates.placeholders.${name}`, name.replace(/_/g, ' '))}
                  </Text>
                  <TextInput
                    style={styles.modalInput}
                    value={placeholderPrompt?.values[name] ?? ''}
                    onChangeText={(v) => setPlaceholderPrompt((p) => (p ? { ...p, values: { ...p.values, [name]: v } } : p))}
                    placeholder={t('templates.enter_value', 'Enter a value...')}
                    placeholderTextColor={c.textMuted}
                  />
                </View>
              ))}
            </ScrollView>
            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalCancel}
                onPress={() => {
                  const p = placeholderPrompt;
                  setPlaceholderPrompt(null);
                  if (p) applyTemplate(p.template, {});
                }}
              >
                <Text style={styles.modalCancelText}>{t('templates.insert_raw', 'Insert Raw')}</Text>
              </Pressable>
              <Pressable
                style={styles.modalConfirm}
                onPress={() => {
                  const p = placeholderPrompt;
                  setPlaceholderPrompt(null);
                  if (!p) return;
                  const values: Record<string, string> = { ...p.auto };
                  for (const [k, v] of Object.entries(p.values)) if (v.trim()) values[k] = v.trim();
                  applyTemplate(p.template, values);
                }}
              >
                <Text style={styles.modalConfirmText}>{t('templates.insert_with_values', 'Insert with Values')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* From options: sub-address tag / From override */}
      <Modal visible={fromOptionsOpen} transparent animationType="fade" onRequestClose={() => setFromOptionsOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('email_composer.from', 'From')}</Text>
            {!overrideEnabled && (
              <>
                <Text style={styles.modalLabel}>{t('identities.sub_address.popover_title', 'Add Sub-Address Tag')}</Text>
                <TextInput
                  style={styles.modalInput}
                  value={tagDraft}
                  onChangeText={setTagDraft}
                  placeholder={t('identities.sub_address.tag_input_placeholder', 'Enter tag (e.g., shopping)')}
                  placeholderTextColor={c.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {!!tagError && (
                  <Text style={styles.scheduleWarning}>
                    {tagError === 'TOO_LONG'
                      ? t('identities.sub_address.validation.too_long', 'Tag must be {max} characters or less', { max: MAX_TAG_LENGTH })
                      : t('identities.sub_address.validation.invalid_chars', 'Tag must contain only letters, numbers, and dashes')}
                  </Text>
                )}
                {tagSuggestions.length > 0 && (
                  <View style={styles.tagRow}>
                    {tagSuggestions.map((s) => (
                      <Pressable key={s} onPress={() => setTagDraft(s)} style={styles.tagChip}>
                        <Text style={styles.tagChipText}>{s}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
                {!!primaryIdentity && (
                  <Text style={styles.modalLabel} numberOfLines={1}>
                    {t('identities.sub_address.preview_label', 'Preview:')} {tagDraft && !tagError
                      ? generateSubAddress(primaryIdentity.email, tagDraft, subAddressDelimiter)
                      : primaryIdentity.email}
                  </Text>
                )}
              </>
            )}
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>{t('email_composer.from_override.toggle_off', 'Override')}</Text>
              <Switch
                value={overrideEnabled}
                onValueChange={setOverrideEnabled}
                accessibilityLabel={t('email_composer.from_override.toggle_off', 'Override')}
              />
            </View>
            {overrideEnabled && (
              <>
                <Text style={styles.modalLabel}>{t('email_composer.from_override.toggle_tooltip', 'Edit the From name and address freely. Mail is still sent through your identity - only the visible From header changes.')}</Text>
                <TextInput
                  style={styles.modalInput}
                  value={overrideName}
                  onChangeText={setOverrideName}
                  placeholder={t('email_composer.from_override.name_placeholder', 'Name')}
                  placeholderTextColor={c.textMuted}
                />
                <TextInput
                  style={styles.modalInput}
                  value={overrideEmail}
                  onChangeText={setOverrideEmail}
                  placeholder={t('email_composer.from_override.email_placeholder', 'alias@example.com')}
                  placeholderTextColor={c.textMuted}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </>
            )}
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={() => setFromOptionsOpen(false)}>
                <Text style={styles.modalCancelText}>{t('email_composer.cancel', 'Cancel')}</Text>
              </Pressable>
              <Pressable style={styles.modalConfirm} onPress={applyFromOptions}>
                <Text style={styles.modalConfirmText}>{t('confirm_dialog.confirm', 'Confirm')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <TemplateSheet
        visible={templateSheetOpen}
        onClose={() => setTemplateSheetOpen(false)}
        onPick={onPickTemplate}
      />

      <IdentitySheet
        visible={identitySheetOpen}
        onClose={() => setIdentitySheetOpen(false)}
        identities={identities}
        selectedIdentityId={selectedIdentityId}
        onPick={(identity) => { setSelectedIdentityId(identity.id); setFromOverride(null); }}
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
  headerTitleWrap: { flex: 1, minWidth: 0 },
  headerTitle: { ...typography.h3, color: c.text },
  headerSubtitle: { ...typography.caption, color: c.textMuted, marginTop: -2 },
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
    position: 'relative',
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
  fromText: { ...typography.body, color: c.text, flexShrink: 1 },
  fromTextOverride: { fontStyle: 'italic' },
  fromOptionsBtn: { paddingTop: 10, paddingHorizontal: 4 },
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
  chipInvalid: { backgroundColor: c.errorBg, borderWidth: 1, borderColor: c.error },
  chipText: { ...typography.caption, color: c.text, flexShrink: 1 },
  chipTextInvalid: { color: c.error },
  recipientInput: {
    flexGrow: 1,
    minWidth: 100,
    ...typography.body,
    color: c.text,
    paddingVertical: 6,
  },
  recipientInputInvalid: { color: c.error },
  suggestionBox: {
    position: 'absolute',
    top: '100%',
    left: spacing.lg + 56 + spacing.md,
    right: spacing.lg,
    borderWidth: 1,
    borderColor: c.borderLight,
    borderRadius: radius.sm,
    backgroundColor: c.card,
    zIndex: 20,
    elevation: 5,
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
  plainEditor: {
    ...typography.body,
    color: c.text,
    minHeight: 220,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    lineHeight: 22,
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
  progressTrack: { height: 3, borderRadius: 2, backgroundColor: c.borderLight, marginTop: 4, overflow: 'hidden' },
  progressFill: { height: 3, backgroundColor: c.primary },

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
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  switchLabel: { ...typography.body, color: c.text },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tagChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: c.surfaceActive,
  },
  tagChipText: { ...typography.caption, color: c.text },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingVertical: spacing.sm },
  swatch: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: c.border },
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
