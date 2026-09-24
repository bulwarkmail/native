import React from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, TextInput, Image, ActivityIndicator, Modal, Platform, ScrollView, TouchableWithoutFeedback, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as DocumentPicker from 'expo-document-picker';
import {
  Search, SquarePen, Menu, Filter, Square, SquareCheck, Minus, X,
  Star, Paperclip, Mail as MailIcon, MailOpen, Trash2, RotateCcw, CalendarDays,
  Archive, FolderInput, Tag, Import, ArrowDownWideNarrow, ArrowUpNarrowWide,
  Pin, Reply, Forward, ShieldAlert, ShieldCheck, Folder,
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useTypography, useDensity } from '../theme/dynamic';
import SidebarDrawer from '../components/SidebarDrawer';
import SenderAvatar from '../components/SenderAvatar';
import { SwipeableRow } from '../components/SwipeableRow';
import { MoveSheet } from '../components/MoveSheet';
import { TagSheet } from '../components/TagSheet';
import { UndoSnackbar } from '../components/UndoSnackbar';
import { OfflineBanner } from '../components/OfflineBanner';
import {
  ListAttachmentChips, ListAttachmentOpener, useListRowAttachments,
} from '../components/email/ListAttachmentChips';
import type { LoadListAttachments } from '../lib/list-attachments';
import { useNetworkStore } from '../stores/network-store';
import { useEmailStore, effectiveFolderScope, type EmailFilters } from '../stores/email-store';
import { useSettingsStore, type SwipeAction, type SwipeMode } from '../stores/settings-store';
import { useKeywordsStore, type KeywordDef } from '../stores/keywords-store';
import { useLocaleStore } from '../stores/locale-store';
import { useSearchHistoryStore } from '../stores/search-history-store';
import { useContactsStore } from '../stores/contacts-store';
import { useOutboxStore } from '../stores/outbox-store';
import { getContactDisplayName } from '../lib/contact-utils';
import { formatListDate } from '../lib/date-format';
import { singleLine } from '../lib/single-line';
import {
  findTrashMailbox, findArchiveMailbox, findJunkMailbox, mailboxesForSiblingOf, ownMailboxes,
} from '../lib/mailbox-tree';
import { localizeMailboxName } from '../lib/mailbox-label';
import {
  collapseThreads, groupByThread, expandThreadSelection, getThreadTagIds, threadKeyOf,
} from '../lib/thread-utils';
import { isPermanentDelete, confirmPermanentDelete } from '../lib/delete-confirm';
import { draftContextFromEmail, isDraftEmail } from '../lib/draft-context';
import { getFullEmail, emptyMailbox as apiEmptyMailbox } from '../api/email';
import type { RootStackParamList } from '../navigation/types';
import type { Attachment, Email } from '../api/types';

function getSenderName(email: Email): string {
  return email.from?.[0]?.name || email.from?.[0]?.email || 'Unknown';
}

function getSenderEmail(email: Email): string | undefined {
  return email.from?.[0]?.email;
}

// Sent/Drafts rows name the recipient, not "me" (webmail 1.4.12).
function getCounterpart(email: Email, showRecipient: boolean): { name: string; email?: string } {
  if (showRecipient) {
    const to = email.to?.[0] ?? email.cc?.[0] ?? email.bcc?.[0];
    if (to) return { name: to.name || to.email, email: to.email };
  }
  return { name: getSenderName(email), email: getSenderEmail(email) };
}

function isUnread(email: Email): boolean {
  return !email.keywords?.$seen;
}

function isStarred(email: Email): boolean {
  return !!email.keywords?.$flagged;
}

function isPinned(email: Email): boolean {
  return !!email.keywords?.$pinned;
}

// Height of the sender line when the avatar is hidden (extra-compact density),
// used to anchor the unread dot on that first line.
const UNREAD_DOT_TEXT_LINE = 20;

const EmailRow = React.memo(function EmailRow({
  item,
  threadCount,
  showPreview,
  showRecipient,
  tagIds,
  keywordDefs,
  disableAvatarImages,
  answered,
  forwarded,
  onPress,
  onLongPress,
  selected,
  selectionMode,
  loadAttachments,
  onOpenAttachment,
}: {
  item: Email;
  threadCount: number;
  showPreview: boolean;
  showRecipient: boolean;
  /** Comma-joined tag ids of the row (thread union) — a string so memo holds. */
  tagIds: string;
  keywordDefs: KeywordDef[];
  disableAvatarImages: boolean;
  answered: boolean;
  forwarded: boolean;
  onPress: (id: string) => void;
  onLongPress: (id: string) => void;
  selected: boolean;
  selectionMode: boolean;
  loadAttachments?: LoadListAttachments;
  onOpenAttachment?: (email: Email, attachment: Attachment) => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const dyn = useTypography();
  const density = useDensity();
  // Read the date-rendering prefs here so each row re-renders when they change.
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const locale = useLocaleStore((s) => s.locale);
  const tr = useLocaleStore((s) => s.t);
  const { name: senderName, email: senderEmail } = getCounterpart(item, showRecipient);
  const unread = isUnread(item);
  const starred = isStarred(item);
  const pinned = isPinned(item);
  const tags = React.useMemo(() => {
    if (!tagIds) return [];
    return tagIds.split(',').map((id) => {
      const def = keywordDefs.find((k) => k.id === id);
      return def
        ? { id, label: def.label, dot: c.tags[def.color]?.dot ?? c.textMuted, text: c.tags[def.color]?.text ?? c.textSecondary, bg: c.tags[def.color]?.bg ?? c.muted }
        // A tag no local definition explains (set by another client): grey,
        // with the raw id so it is at least visible and removable.
        : { id, label: id, dot: c.tags.gray.dot, text: c.tags.gray.text, bg: c.tags.gray.bg };
    });
  }, [tagIds, keywordDefs, c]);

  const handlePress = React.useCallback(() => onPress(item.id), [onPress, item.id]);
  const handleLongPress = React.useCallback(() => onLongPress(item.id), [onLongPress, item.id]);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.emailRow,
        { paddingVertical: density.rowPaddingVertical },
        pressed && styles.emailRowPressed,
        selected && styles.emailRowSelected,
      ]}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={300}
    >
      {unread && (
        <View
          style={[
            styles.unreadDot,
            { top: density.rowPaddingVertical + (density.showAvatar ? componentSizes.avatarMd : UNREAD_DOT_TEXT_LINE) / 2 - 4 },
          ]}
        />
      )}
      {selectionMode && (
        <View style={styles.rowCheckboxWrap}>
          {selected ? (
            <SquareCheck size={16} color={c.primary} />
          ) : (
            <Square size={16} color={c.textMuted} />
          )}
        </View>
      )}
      {density.showAvatar && (
        <SenderAvatar
          name={senderName}
          email={senderEmail}
          size={componentSizes.avatarMd}
          disableImages={disableAvatarImages}
        />
      )}

      {/* Content */}
      <View style={styles.emailContent}>
        {/* Row 1: Sender + indicators + time */}
        <View style={styles.emailHeaderRow}>
          <View style={styles.senderRow}>
            <Text style={[styles.emailFrom, dyn.bodyMedium, unread && styles.textUnread]} numberOfLines={1}>
              {senderName}
            </Text>
            {pinned && (
              <Pin size={componentSizes.statusIcon} color={c.primary} fill={c.primary} />
            )}
            {starred && (
              <Star size={componentSizes.statusIcon} color={c.starred} fill={c.starred} />
            )}
            {answered && (
              <Reply size={componentSizes.statusIcon} color={c.textMuted} />
            )}
            {forwarded && (
              <Forward size={componentSizes.statusIcon} color={c.textMuted} />
            )}
            {item.hasAttachment && (
              <Paperclip size={componentSizes.statusIcon} color={c.textMuted} />
            )}
          </View>
          <View style={styles.timeAndTag}>
            {threadCount > 1 && (
              <View style={styles.threadBadge}>
                <Text style={styles.threadBadgeText}>{threadCount}</Text>
              </View>
            )}
            <Text style={[styles.emailDate, dyn.caption]}>{formatListDate(item.receivedAt, { dateFormat, timeFormat, locale, t: tr })}</Text>
          </View>
        </View>

        {/* Row 2: Subject + tag pills */}
        <View style={styles.subjectRow}>
          <Text style={[styles.emailSubject, dyn.body, unread && styles.textBold]} numberOfLines={1}>
            {singleLine(item.subject) || '(no subject)'}
          </Text>
          {tags.slice(0, 3).map((tag) => (
            <View key={tag.id} style={[styles.tagPill, { backgroundColor: tag.bg }]}>
              <View style={[styles.tagDot, { backgroundColor: tag.dot }]} />
              <Text style={[styles.tagText, { color: tag.text }]} numberOfLines={1}>{tag.label}</Text>
            </View>
          ))}
          {tags.length > 3 && (
            <Text style={[styles.tagText, { color: c.textMuted }]}>+{tags.length - 3}</Text>
          )}
        </View>

        {/* Row 3: Preview - hidden in compact density modes regardless of toggle */}
        {showPreview && density.showPreview && (
          <Text style={[styles.emailPreview, dyn.body]} numberOfLines={2}>
            {singleLine(item.preview)}
          </Text>
        )}
        {onOpenAttachment && (
          <ListAttachmentChips
            email={item}
            load={loadAttachments}
            onOpen={onOpenAttachment}
            disabled={selectionMode}
          />
        )}
      </View>
    </Pressable>
  );
});

// A list row: the swipe wrapper around the email row. Its props are all
// primitives or stable callbacks, so a re-render of the list (the refresh
// flag, a new page, another row's selection) only re-renders the rows whose
// own data changed; the swipe context and callback are built here, per row,
// to keep their identity as well.
const EmailListItem = React.memo(function EmailListItem({
  swipeLeftAction,
  swipeRightAction,
  swipeMode,
  inJunk,
  onSwipe,
  ...rowProps
}: React.ComponentProps<typeof EmailRow> & {
  swipeLeftAction: SwipeAction;
  swipeRightAction: SwipeAction;
  swipeMode: SwipeMode;
  inJunk: boolean;
  onSwipe: (id: string, action: SwipeAction) => void;
}) {
  const { item } = rowProps;
  const unread = isUnread(item);
  const starred = isStarred(item);
  const pinned = isPinned(item);
  const context = React.useMemo(
    () => ({ unread, starred, pinned, inJunk }),
    [unread, starred, pinned, inJunk],
  );
  const onAction = React.useCallback(
    (action: SwipeAction) => onSwipe(item.id, action),
    [onSwipe, item.id],
  );
  return (
    <SwipeableRow
      leftAction={swipeLeftAction}
      rightAction={swipeRightAction}
      mode={swipeMode}
      context={context}
      onAction={onAction}
    >
      <EmailRow {...rowProps} />
    </SwipeableRow>
  );
});

function EmailRowSeparator() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return <View style={styles.separator} />;
}

const emailKeyExtractor = (item: Email) => item.id;

interface EmailListScreenProps {
  onEmailPress?: (email: Email) => void;
  onComposePress?: () => void;
}

export default function EmailListScreen({ onEmailPress, onComposePress }: EmailListScreenProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  // The navigator's safe-area provider knows the insets on the first render;
  // the native SafeAreaView only learned them a few frames later on Fabric,
  // so the header first drew under the status bar and then jumped down.
  const insets = useSafeAreaInsets();
  const { t } = useLocaleStore();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = React.useState(false);
  const emails = useEmailStore((s) => s.emails);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const loading = useEmailStore((s) => s.loading);
  const error = useEmailStore((s) => s.error);
  const currentMailboxId = useEmailStore((s) => s.currentMailboxId);
  const storeSearchQuery = useEmailStore((s) => s.searchQuery);
  const filters = useEmailStore((s) => s.filters);
  const fetchMailboxes = useEmailStore((s) => s.fetchMailboxes);
  const selectMailbox = useEmailStore((s) => s.selectMailbox);
  const loadMoreEmails = useEmailStore((s) => s.loadMoreEmails);
  const refreshEmails = useEmailStore((s) => s.refreshEmails);
  const importEmails = useEmailStore((s) => s.importEmails);
  const setSearchQuery = useEmailStore((s) => s.setSearchQuery);
  const setFilters = useEmailStore((s) => s.setFilters);
  const clearSearchAndFilters = useEmailStore((s) => s.clearSearchAndFilters);
  const markRead = useEmailStore((s) => s.markRead);
  const markUnread = useEmailStore((s) => s.markUnread);
  const toggleStar = useEmailStore((s) => s.toggleStar);
  const togglePin = useEmailStore((s) => s.togglePin);
  const deleteEmailAction = useEmailStore((s) => s.deleteEmail);
  const moveToMailboxAction = useEmailStore((s) => s.moveToMailbox);
  const archiveEmailAction = useEmailStore((s) => s.archiveEmail);
  const archiveEmailsBatch = useEmailStore((s) => s.archiveEmailsBatch);
  const moveEmailsToMailbox = useEmailStore((s) => s.moveEmailsToMailbox);
  const deleteEmailsBatch = useEmailStore((s) => s.deleteEmailsBatch);
  const setKeywordForEmails = useEmailStore((s) => s.setKeywordForEmails);
  const setSortAscending = useEmailStore((s) => s.setSortAscending);
  const markSpam = useEmailStore((s) => s.markSpam);
  const unmarkSpam = useEmailStore((s) => s.unmarkSpam);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const keywordDefs = useKeywordsStore((s) => s.keywords);
  const keywordsHydrated = useKeywordsStore((s) => s.hydrated);
  const hydrateKeywords = useKeywordsStore((s) => s.hydrate);
  React.useEffect(() => { if (!keywordsHydrated) void hydrateKeywords(); }, [keywordsHydrated, hydrateKeywords]);
  const addRecentSearch = useSearchHistoryStore((s) => s.addRecentSearch);
  const recentSearches = useSearchHistoryStore((s) => s.recentSearches);
  const removeRecentSearch = useSearchHistoryStore((s) => s.removeRecentSearch);
  const contacts = useContactsStore((s) => s.contacts);
  // Queued changes the server rejected repeatedly: surfaced with retry/discard
  // instead of being dropped silently.
  const failedOps = useOutboxStore((s) => s.failed);
  const retryFailedOps = useOutboxStore((s) => s.retryFailed);
  const discardFailedOps = useOutboxStore((s) => s.discardFailed);

  const swipeLeftAction = useSettingsStore((s) => s.swipeLeftAction);
  const swipeRightAction = useSettingsStore((s) => s.swipeRightAction);
  const swipeMode = useSettingsStore((s) => s.swipeMode);
  const showPreview = useSettingsStore((s) => s.showPreview);
  const disableThreading = useSettingsStore((s) => s.disableThreading);
  const sortAscending = useSettingsStore((s) => s.mailSortAscending);
  const showAvatarsInJunk = useSettingsStore((s) => s.showAvatarsInJunk);
  const deleteAction = useSettingsStore((s) => s.deleteAction);
  const permanentlyDeleteJunk = useSettingsStore((s) => s.permanentlyDeleteJunk);
  const networkOnline = useNetworkStore((s) => s.online);

  const currentMailbox = React.useMemo(
    () => mailboxes.find((m) => m.id === currentMailboxId),
    [mailboxes, currentMailboxId],
  );
  const currentRole = currentMailbox?.role ?? null;
  // The JMAP account behind the open folder (undefined = the user's own).
  const currentOwnerAccountId = currentMailbox?.isShared ? currentMailbox.accountId : undefined;
  const inJunk = currentRole === 'junk' || currentRole === 'spam';
  const showRecipient = currentRole === 'sent' || currentRole === 'drafts';

  // When threading is on, collapse same-thread emails so the list shows the
  // newest message per thread with a count badge (pinned threads first).
  // Disabling threading falls back to the flat list (every message is its
  // own row).
  const visibleEmails = React.useMemo(
    () => collapseThreads(emails, disableThreading),
    [emails, disableThreading],
  );
  const threadGroups = React.useMemo(
    () => groupByThread(emails, disableThreading),
    [emails, disableThreading],
  );

  // Real conversation sizes from Thread/get (a thread's other messages may
  // live in other folders), fetched by the store together with each list
  // page; the loaded-page count is the fallback until they land and for
  // messages whose thread the server no longer knows.
  const serverThreadCounts = useEmailStore((s) => s.threadCounts);

  const threadCountFor = React.useCallback((e: Email): number => {
    if (disableThreading) return 1;
    const local = threadGroups.get(threadKeyOf(e, false))?.length ?? 1;
    const server = e.threadId ? serverThreadCounts[e.threadId] : undefined;
    return Math.max(local, server ?? 1);
  }, [disableThreading, threadGroups, serverThreadCounts]);

  // Tags per row: the union of every loaded message of the thread (the row
  // stands in for all of them), joined so the memoized row keeps its identity.
  const rowTagIds = React.useMemo(() => {
    const out = new Map<string, string>();
    for (const [key, list] of threadGroups) out.set(key, getThreadTagIds(list).join(','));
    return out;
  }, [threadGroups]);
  const rowFlags = React.useMemo(() => {
    const out = new Map<string, { answered: boolean; forwarded: boolean }>();
    for (const [key, list] of threadGroups) {
      out.set(key, {
        answered: list.some((e) => !!e.keywords?.$answered),
        forwarded: list.some((e) => !!e.keywords?.$forwarded),
      });
    }
    return out;
  }, [threadGroups]);

  // Role folders must come from the account the open folder belongs to: a
  // shared (group account) message can only be filed into that account's
  // Archive/Trash/Junk, never the user's own.
  const scopedMailboxes = React.useMemo(
    () => mailboxesForSiblingOf(mailboxes, currentMailboxId),
    [mailboxes, currentMailboxId],
  );
  const { loadAttachments, openAttachment, openerRef: attachmentOpenerRef } = useListRowAttachments(
    mailboxes, currentMailboxId,
  );
  const archiveMailboxId = React.useMemo(
    () => findArchiveMailbox(scopedMailboxes)?.id ?? null,
    [scopedMailboxes],
  );
  const trashMailboxId = React.useMemo(
    () => findTrashMailbox(scopedMailboxes)?.id ?? null,
    [scopedMailboxes],
  );
  const junkMailboxId = React.useMemo(
    () => findJunkMailbox(scopedMailboxes)?.id ?? null,
    [scopedMailboxes],
  );

  // Import .eml / .zip files into the current mailbox (falls back to Inbox).
  const [importing, setImporting] = React.useState(false);
  const handleImport = React.useCallback(async () => {
    const targetMailboxId =
      currentMailboxId ?? ownMailboxes(mailboxes).find((m) => m.role === 'inbox')?.id ?? null;
    if (!targetMailboxId || importing) return;
    let result: DocumentPicker.DocumentPickerResult;
    try {
      result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
        type: [
          'message/rfc822',
          'application/zip',
          'application/x-zip-compressed',
          'application/octet-stream',
        ],
      });
    } catch {
      return; // picker dismissed / unavailable
    }
    if (result.canceled) return;
    if (result.assets.length === 0) return;
    setImporting(true);
    try {
      const files = result.assets.map((a) => ({
        uri: a.uri,
        name: a.name,
        mimeType: a.mimeType,
      }));
      const { imported, failed } = await importEmails(files, targetMailboxId);
      Alert.alert(
        'Import',
        failed > 0
          ? `${imported} imported, ${failed} failed.`
          : imported === 0
            ? 'No messages were imported.'
            : `${imported} message${imported === 1 ? '' : 's'} imported.`,
      );
    } finally {
      setImporting(false);
    }
  }, [currentMailboxId, mailboxes, importEmails, importing]);

  // Move-to-folder picker triggered by the swipe action.
  const [pendingMoveId, setPendingMoveId] = React.useState<string | null>(null);
  // Batch (multi-select) sheets.
  const [batchMoveOpen, setBatchMoveOpen] = React.useState(false);
  const [tagSheetOpen, setTagSheetOpen] = React.useState(false);

  // Selection state
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const selectionMode = selectedIds.size > 0;
  const allSelected =
    visibleEmails.length > 0 && visibleEmails.every((e) => selectedIds.has(e.id));

  // Refs so row press handlers stay referentially stable across renders.
  // FlatList rows then skip re-render when the parent re-renders for unrelated
  // reasons (e.g. opening the filter modal).
  const onEmailPressRef = React.useRef(onEmailPress);
  React.useEffect(() => { onEmailPressRef.current = onEmailPress; }, [onEmailPress]);
  const selectionModeRef = React.useRef(selectionMode);
  React.useEffect(() => { selectionModeRef.current = selectionMode; }, [selectionMode]);
  const emailsRef = React.useRef(emails);
  React.useEffect(() => { emailsRef.current = emails; }, [emails]);

  const toggleSelect = React.useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // A draft opens in the composer, not the read-only viewer (webmail
  // `handleEditDraft`). Needs the full message for its body and attachments.
  const [openingDraftId, setOpeningDraftId] = React.useState<string | null>(null);
  const openDraft = React.useCallback(async (email: Email) => {
    if (openingDraftId) return;
    setOpeningDraftId(email.id);
    try {
      const full = await getFullEmail(email.id, currentOwnerAccountId);
      navigation.navigate('Compose', { draft: draftContextFromEmail(full, currentOwnerAccountId) });
    } catch (err) {
      Alert.alert(
        t('email_list.error', 'Error'),
        err instanceof Error ? err.message : t('email_list.open_draft_failed', 'Could not open the draft.'),
      );
    } finally {
      setOpeningDraftId(null);
    }
  }, [openingDraftId, currentOwnerAccountId, navigation, t]);
  const openDraftRef = React.useRef(openDraft);
  React.useEffect(() => { openDraftRef.current = openDraft; }, [openDraft]);
  const currentRoleRef = React.useRef(currentRole);
  React.useEffect(() => { currentRoleRef.current = currentRole; }, [currentRole]);

  const handleRowPress = React.useCallback((id: string) => {
    if (selectionModeRef.current) {
      toggleSelect(id);
    } else {
      const email = emailsRef.current.find((e) => e.id === id);
      if (!email) return;
      if (isDraftEmail(email, currentRoleRef.current)) void openDraftRef.current(email);
      else onEmailPressRef.current?.(email);
    }
  }, [toggleSelect]);

  // Every loaded message of the row's thread: swipe/batch actions on a
  // collapsed conversation act on all of them, not just the representative.
  const idsForRow = React.useCallback(
    (id: string) => expandThreadSelection([id], emailsRef.current, disableThreading),
    [disableThreading],
  );

  // Trash / permanent delete with the confirm the webmail shows before any
  // destroy (Trash folder, "permanent" delete action, junk auto-permanent).
  const deleteIds = React.useCallback(async (ids: string[]) => {
    if (!currentMailboxId) return;
    if (!trashMailboxId) {
      Alert.alert(
        t('email_list.error', 'Error'),
        t('email_list.no_trash_folder', 'Could not find a Trash folder on the server. Please check your mailbox configuration.'),
      );
      return;
    }
    const permanent = isPermanentDelete({
      inTrash: currentMailboxId === trashMailboxId,
      inJunk,
      deleteAction,
      permanentlyDeleteJunk,
    });
    if (permanent && !(await confirmPermanentDelete(ids.length, t))) return;
    if (ids.length === 1) await deleteEmailAction(ids[0], trashMailboxId, currentMailboxId);
    else await deleteEmailsBatch(ids, trashMailboxId, currentMailboxId);
  }, [currentMailboxId, trashMailboxId, inJunk, deleteAction, permanentlyDeleteJunk, deleteEmailAction, deleteEmailsBatch, t]);

  const handleSwipeAction = React.useCallback((id: string, action: SwipeAction) => {
    if (action === 'none') return;
    const email = emailsRef.current.find((e) => e.id === id);
    if (!email || !currentMailboxId) return;
    switch (action) {
      case 'archive':
        if (archiveMailboxId && currentMailboxId !== archiveMailboxId) {
          const ids = idsForRow(id);
          if (ids.length > 1) void archiveEmailsBatch(ids);
          else void archiveEmailAction(id);
        } else if (!archiveMailboxId) {
          Alert.alert(
            t('email_list.error', 'Error'),
            t('email_list.no_archive_folder', 'Could not find an Archive folder on the server.'),
          );
        }
        break;
      case 'delete':
        void deleteIds(idsForRow(id));
        break;
      case 'spam':
        // Your own outgoing mail is never spam (webmail hides the action in
        // Sent/Drafts); inside Junk the same swipe means "not spam".
        if (currentRole === 'sent' || currentRole === 'drafts') break;
        if (inJunk) {
          void unmarkSpam(idsForRow(id));
        } else if (junkMailboxId) {
          void markSpam(idsForRow(id));
        } else {
          Alert.alert(
            t('email_list.error', 'Error'),
            t('email_list.no_junk_folder', 'Could not find a Spam/Junk folder on the server.'),
          );
        }
        break;
      case 'read':
        if (isUnread(email)) void markRead(id);
        else void markUnread(id);
        break;
      case 'star':
        void toggleStar(id, !isStarred(email));
        break;
      case 'pin':
        void togglePin(id, !isPinned(email));
        break;
      case 'move':
        setPendingMoveId(id);
        break;
    }
  }, [
    currentMailboxId, archiveMailboxId, junkMailboxId, currentRole, inJunk,
    archiveEmailAction, archiveEmailsBatch, deleteIds, markSpam, unmarkSpam, idsForRow,
    markRead, markUnread, toggleStar, togglePin, t,
  ]);

  // Rows keep one swipe callback for their whole life. It reads the current
  // handler, so a rebuilt handler (say, once the folder ids load) neither
  // goes stale in a row nor re-renders every row.
  const handleSwipeActionRef = React.useRef(handleSwipeAction);
  React.useEffect(() => { handleSwipeActionRef.current = handleSwipeAction; }, [handleSwipeAction]);
  const handleRowSwipe = React.useCallback(
    (id: string, action: SwipeAction) => handleSwipeActionRef.current(id, action),
    [],
  );

  const renderEmailRow = React.useCallback(
    ({ item }: { item: Email }) => {
      const key = threadKeyOf(item, disableThreading);
      const flags = rowFlags.get(key);
      return (
        <EmailListItem
          swipeLeftAction={selectionMode ? 'none' : swipeLeftAction}
          swipeRightAction={selectionMode ? 'none' : swipeRightAction}
          swipeMode={swipeMode}
          inJunk={inJunk}
          onSwipe={handleRowSwipe}
          item={item}
          threadCount={threadCountFor(item)}
          showPreview={showPreview}
          showRecipient={showRecipient}
          tagIds={rowTagIds.get(key) ?? ''}
          keywordDefs={keywordDefs}
          disableAvatarImages={inJunk && !showAvatarsInJunk}
          answered={flags?.answered ?? false}
          forwarded={flags?.forwarded ?? false}
          selected={selectedIds.has(item.id)}
          selectionMode={selectionMode}
          onPress={handleRowPress}
          onLongPress={toggleSelect}
          loadAttachments={loadAttachments}
          onOpenAttachment={openAttachment}
        />
      );
    },
    [
      selectedIds, selectionMode, handleRowPress, toggleSelect, swipeLeftAction, swipeRightAction,
      swipeMode, handleRowSwipe, disableThreading, rowFlags, rowTagIds, threadCountFor,
      showPreview, showRecipient, keywordDefs, inJunk, showAvatarsInJunk,
      loadAttachments, openAttachment,
    ],
  );
  const handleEndReached = React.useCallback(() => { void loadMoreEmails(); }, [loadMoreEmails]);
  const handleRefresh = React.useCallback(() => { void refreshEmails(); }, [refreshEmails]);

  const clearSelection = React.useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const toggleSelectAllVisible = React.useCallback(() => {
    setSelectedIds((prev) => {
      const allCurrent = visibleEmails.length > 0 && visibleEmails.every((e) => prev.has(e.id));
      if (allCurrent) return new Set();
      return new Set(visibleEmails.map((e) => e.id));
    });
  }, [visibleEmails]);

  // Clear selection when mailbox changes
  React.useEffect(() => {
    setSelectedIds(new Set());
  }, [currentMailboxId]);

  // `selectedIds` holds the representative row ids; every action expands to
  // all loaded messages of the selected conversations (webmail
  // `toggleThreadSelection`), so "3 selected" conversations never means
  // "3 messages touched".
  const selectedMessageIds = React.useMemo(
    () => expandThreadSelection(selectedIds, emails, disableThreading),
    [selectedIds, emails, disableThreading],
  );
  const selectedEmails = React.useMemo(() => {
    const wanted = new Set(selectedMessageIds);
    return emails.filter((e) => wanted.has(e.id));
  }, [emails, selectedMessageIds]);
  const allSelectedAreRead = selectedEmails.length > 0 && selectedEmails.every((e) => !isUnread(e));
  const allSelectedAreStarred = selectedEmails.length > 0 && selectedEmails.every((e) => isStarred(e));

  // One Email/set for the whole selection, not a request per message.
  const handleBulkMarkReadToggle = async () => {
    await setKeywordForEmails(selectedMessageIds, '$seen', !allSelectedAreRead);
    clearSelection();
  };

  const handleBulkStar = async () => {
    await setKeywordForEmails(selectedMessageIds, '$flagged', !allSelectedAreStarred);
    clearSelection();
  };

  const handleBulkDelete = async () => {
    const trash = findTrashMailbox(scopedMailboxes);
    if (!trash || !currentMailboxId) {
      clearSelection();
      return;
    }
    const ids = selectedMessageIds;
    const permanent = isPermanentDelete({
      inTrash: currentMailboxId === trash.id,
      inJunk,
      deleteAction,
      permanentlyDeleteJunk,
    });
    if (permanent && !(await confirmPermanentDelete(ids.length, t))) return;
    await deleteEmailsBatch(ids, trash.id, currentMailboxId);
    clearSelection();
  };

  const handleBulkArchive = async () => {
    await archiveEmailsBatch(selectedMessageIds);
    clearSelection();
  };

  const handleBulkSpam = async () => {
    const ids = selectedMessageIds;
    if (inJunk) await unmarkSpam(ids);
    else await markSpam(ids);
    clearSelection();
  };

  const canArchiveSelection =
    archiveMailboxId != null && currentMailboxId !== archiveMailboxId;
  const canSpamSelection =
    currentRole !== 'sent' && currentRole !== 'drafts' && (inJunk || junkMailboxId != null);

  const handleBatchMovePick = (toId: string) => {
    const ids = selectedMessageIds;
    setBatchMoveOpen(false);
    clearSelection();
    void moveEmailsToMailbox(ids, toId);
  };

  const handleBatchTagToggle = (token: string, on: boolean) => {
    void setKeywordForEmails(selectedMessageIds, token, on);
  };

  // Local input state for uninterrupted typing. The search runs on submit,
  // or after a 600 ms pause once at least two characters are typed — with
  // the `*` wildcard a single letter matches the whole mailbox.
  const [searchInput, setSearchInput] = React.useState(storeSearchQuery);
  const [searchFocused, setSearchFocused] = React.useState(false);
  React.useEffect(() => {
    // Keep local input in sync when the store is cleared externally
    // (e.g. clearing the search from the chips row).
    if (storeSearchQuery !== searchInput && storeSearchQuery === '') {
      setSearchInput('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeSearchQuery]);
  React.useEffect(() => {
    if (searchInput === storeSearchQuery) return;
    const trimmed = searchInput.trim();
    if (trimmed.length > 0 && trimmed.length < 2) return;
    const id = setTimeout(() => setSearchQuery(searchInput), 600);
    return () => clearTimeout(id);
  }, [searchInput, storeSearchQuery, setSearchQuery]);
  const submitSearch = React.useCallback((value: string) => {
    setSearchInput(value);
    setSearchQuery(value);
    if (value.trim()) addRecentSearch(value);
    setSearchFocused(false);
  }, [setSearchQuery, addRecentSearch]);
  // People whose name/address matches what is being typed (#845); picking
  // one turns the search into a `from:` filter like the webmail.
  const contactSuggestions = React.useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: Array<{ name: string; email: string }> = [];
    for (const card of contacts) {
      const name = getContactDisplayName(card);
      for (const em of Object.values(card.emails ?? {})) {
        const address = em.address;
        if (!address) continue;
        if (name.toLowerCase().includes(q) || address.toLowerCase().includes(q)) {
          out.push({ name, email: address });
          break;
        }
      }
      if (out.length >= 4) break;
    }
    return out;
  }, [contacts, searchInput]);

  const activeFilterCount =
    (filters.from ? 1 : 0) +
    (filters.to ? 1 : 0) +
    (filters.subject ? 1 : 0) +
    (filters.body ? 1 : 0) +
    (filters.dateAfter ? 1 : 0) +
    (filters.dateBefore ? 1 : 0) +
    (filters.hasAttachment !== undefined ? 1 : 0) +
    (filters.isStarred !== undefined ? 1 : 0) +
    (filters.isUnread !== undefined ? 1 : 0) +
    (filters.keyword ? 1 : 0) +
    (filters.folder && filters.folder !== 'current' ? 1 : 0);
  const hasActiveSearchOrFilter = Boolean(storeSearchQuery) || activeFilterCount > 0;
  const folderScope = effectiveFolderScope(storeSearchQuery, filters);
  const scopeFolderName = React.useMemo(() => {
    if (folderScope === 'all' || folderScope === 'current') return null;
    const m = mailboxes.find((mb) => mb.id === folderScope);
    return m ? localizeMailboxName(m.role, m.name, t) : folderScope;
  }, [folderScope, mailboxes, t]);
  const keywordFilterLabel = React.useMemo(() => {
    if (!filters.keyword) return null;
    const id = filters.keyword.replace(/^\$label:/, '').replace(/^\$color:/, '');
    return keywordDefs.find((k) => k.id === id)?.label ?? id;
  }, [filters.keyword, keywordDefs]);
  const setFolderScope = (scope: string) => {
    const updated: EmailFilters = { ...filters };
    if (scope === 'current') delete updated.folder;
    else updated.folder = scope;
    setFilters(updated);
  };

  const cycleTriStateTo = (key: 'hasAttachment' | 'isStarred' | 'isUnread', next: boolean | undefined) => {
    const updated: EmailFilters = { ...filters };
    if (next === undefined) delete updated[key];
    else updated[key] = next;
    setFilters(updated);
  };
  const cycleTriState = (key: 'hasAttachment' | 'isStarred' | 'isUnread') => {
    const current = filters[key];
    // unset → true → false → unset
    cycleTriStateTo(key, current === undefined ? true : current === true ? false : undefined);
  };

  const setFilterField = (key: keyof EmailFilters, value: string | undefined) => {
    const updated: EmailFilters = { ...filters };
    if (!value) delete updated[key];
    else (updated as Record<string, unknown>)[key] = value;
    setFilters(updated);
  };

  const [datePickerField, setDatePickerField] = React.useState<'dateAfter' | 'dateBefore' | null>(null);

  const headerTitle = React.useMemo(() => {
    if (!currentMailbox) return t('sidebar.mailboxes.inbox', 'Inbox');
    const name = localizeMailboxName(currentMailbox.role, currentMailbox.name, t);
    // Name the owning group account — a bare "Inbox" would look like the
    // user's own.
    return currentMailbox.isShared && currentMailbox.accountName
      ? `${currentMailbox.accountName} · ${name}`
      : name;
  }, [currentMailbox, t]);

  // "Empty folder" for Trash and Junk (webmail banner; #711 pagination lives
  // in the api helper).
  const [emptying, setEmptying] = React.useState(false);
  const canEmptyFolder =
    (currentRole === 'trash' || inJunk) && !!currentMailbox && (currentMailbox.totalEmails > 0 || emails.length > 0);
  const handleEmptyFolder = () => {
    if (!currentMailbox || emptying) return;
    Alert.alert(
      t('email_list.empty_folder.confirm_title', 'Empty folder'),
      t('email_list.empty_folder.confirm_message', 'All emails in this folder will be permanently deleted. This action cannot be undone.'),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: t('email_list.empty_folder.confirm_button', 'Empty folder'),
          style: 'destructive',
          onPress: () => {
            setEmptying(true);
            void apiEmptyMailbox(currentMailbox.originalId ?? currentMailbox.id, currentOwnerAccountId)
              .then(async () => {
                clearSelection();
                await Promise.all([refreshEmails(), fetchMailboxes()]);
              })
              .catch((err: unknown) => {
                Alert.alert(
                  t('email_list.error', 'Error'),
                  err instanceof Error ? err.message : t('mailbox_context_menu.toast_error_empty', 'Failed to empty folder'),
                );
              })
              .finally(() => setEmptying(false));
          },
        },
      ],
    );
  };

  // Load mailboxes and select inbox on mount
  React.useEffect(() => {
    if (mailboxes.length === 0) {
      void fetchMailboxes();
    }
  }, [fetchMailboxes, mailboxes.length]);

  React.useEffect(() => {
    if (mailboxes.length > 0 && !currentMailboxId) {
      const own = ownMailboxes(mailboxes);
      const inbox = own.find((m) => m.role === 'inbox') || own[0];
      if (!inbox) return;
      void selectMailbox(inbox.id);
    }
  }, [mailboxes, currentMailboxId, selectMailbox]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      {selectionMode ? (
        <View style={styles.header}>
          <Pressable onPress={clearSelection} style={styles.headerButton}>
            <X size={20} color={c.text} />
          </Pressable>
          <Text style={styles.headerTitle}>{selectedIds.size} selected</Text>
          <Pressable
            onPress={() => { void handleBulkStar(); }}
            style={styles.headerButton}
            hitSlop={6}
          >
            <Star
              size={20}
              color={allSelectedAreStarred ? c.starred : c.text}
              fill={allSelectedAreStarred ? c.starred : 'transparent'}
            />
          </Pressable>
          <Pressable
            onPress={() => { void handleBulkMarkReadToggle(); }}
            style={styles.headerButton}
            hitSlop={6}
          >
            {allSelectedAreRead ? (
              <MailIcon size={20} color={c.text} />
            ) : (
              <MailOpen size={20} color={c.text} />
            )}
          </Pressable>
          <Pressable
            onPress={() => setTagSheetOpen(true)}
            style={styles.headerButton}
            hitSlop={6}
          >
            <Tag size={20} color={c.text} />
          </Pressable>
          <Pressable
            onPress={() => setBatchMoveOpen(true)}
            style={styles.headerButton}
            hitSlop={6}
          >
            <FolderInput size={20} color={c.text} />
          </Pressable>
          {canSpamSelection && (
            <Pressable
              onPress={() => { void handleBulkSpam(); }}
              style={styles.headerButton}
              hitSlop={6}
              accessibilityLabel={inJunk ? t('context_menu.not_spam', 'Not spam') : t('context_menu.mark_as_spam', 'Report spam')}
            >
              {inJunk ? (
                <ShieldCheck size={20} color={c.text} />
              ) : (
                <ShieldAlert size={20} color={c.text} />
              )}
            </Pressable>
          )}
          {canArchiveSelection && (
            <Pressable
              onPress={() => { void handleBulkArchive(); }}
              style={styles.headerButton}
              hitSlop={6}
            >
              <Archive size={20} color={c.text} />
            </Pressable>
          )}
          <Pressable
            onPress={() => { void handleBulkDelete(); }}
            style={styles.headerButton}
            hitSlop={6}
          >
            <Trash2 size={20} color={c.text} />
          </Pressable>
        </View>
      ) : (
        <View style={styles.header}>
          <Pressable onPress={() => setDrawerOpen(true)} style={styles.headerButton}>
            <Menu size={20} color={c.textMuted} />
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {headerTitle}
          </Text>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => { void handleImport(); }}
            style={styles.headerButton}
            disabled={importing}
            hitSlop={6}
          >
            {importing ? (
              <ActivityIndicator size="small" color={c.textMuted} />
            ) : (
              <Import size={20} color={c.textMuted} />
            )}
          </Pressable>
          <Image
            source={require('../../assets/logos/Bulwark Logo White.png')}
            style={styles.headerLogo}
            resizeMode="contain"
          />
        </View>
      )}

      {/* Search bar (always visible) */}
      <View style={styles.searchBar}>
        <Pressable style={styles.checkboxButton} onPress={toggleSelectAllVisible} hitSlop={6}>
          {allSelected ? (
            <SquareCheck size={18} color={c.primary} />
          ) : selectionMode ? (
            <View style={styles.checkboxIndeterminate}>
              <Minus size={14} color={c.background} />
            </View>
          ) : (
            <Square size={18} color={c.textMuted} />
          )}
        </Pressable>
        <View style={styles.searchInputArea}>
          <Search size={16} color={c.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder={t('email_list.search_placeholder', 'Search mail...')}
            placeholderTextColor={c.textMuted}
            value={searchInput}
            onChangeText={setSearchInput}
            onFocus={() => setSearchFocused(true)}
            // Delay so a tap on a recent-search row lands before the list hides.
            onBlur={() => { setTimeout(() => setSearchFocused(false), 150); }}
            onSubmitEditing={() => submitSearch(searchInput)}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {searchInput.length > 0 && (
            <Pressable
              onPress={() => { setSearchInput(''); setSearchQuery(''); }}
              hitSlop={8}
              style={styles.searchClearButton}
            >
              <X size={14} color={c.textMuted} />
            </Pressable>
          )}
        </View>
        <Pressable
          style={styles.filterButton}
          onPress={() => setSortAscending(!sortAscending)}
          accessibilityRole="button"
          accessibilityLabel={sortAscending ? 'Sorted oldest first' : 'Sorted newest first'}
          accessibilityHint="Reverses the mail sort order"
        >
          {sortAscending ? (
            <ArrowUpNarrowWide size={18} color={c.primary} />
          ) : (
            <ArrowDownWideNarrow size={18} color={c.textMuted} />
          )}
        </Pressable>
        <Pressable
          style={[styles.filterButton, activeFilterCount > 0 && styles.filterButtonActive]}
          onPress={() => setFilterMenuOpen(true)}
        >
          <Filter size={18} color={activeFilterCount > 0 ? c.primary : c.textMuted} />
          {activeFilterCount > 0 && (
            <View style={styles.filterBadge}>
              <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
            </View>
          )}
        </Pressable>
      </View>

      {searchFocused && ((!searchInput.trim() && recentSearches.length > 0) || contactSuggestions.length > 0) && (
        <View style={styles.recentSearches}>
          {!searchInput.trim() && recentSearches.length > 0 && (
            <>
              <Text style={styles.recentSearchesTitle}>{t('advanced_search.suggestions_recent', 'Recent searches')}</Text>
              {recentSearches.slice(0, 5).map((q) => (
                <View key={q} style={styles.recentSearchRow}>
                  <Pressable style={styles.recentSearchMain} onPress={() => submitSearch(q)}>
                    <Search size={12} color={c.textMuted} />
                    <Text style={styles.recentSearchText} numberOfLines={1}>{q}</Text>
                  </Pressable>
                  <Pressable onPress={() => removeRecentSearch(q)} hitSlop={8}>
                    <X size={12} color={c.textMuted} />
                  </Pressable>
                </View>
              ))}
            </>
          )}
          {contactSuggestions.length > 0 && (
            <>
              <Text style={styles.recentSearchesTitle}>{t('advanced_search.suggestions_people', 'People')}</Text>
              {contactSuggestions.map((p) => (
                <Pressable
                  key={p.email}
                  style={[styles.recentSearchRow, styles.recentSearchMain]}
                  onPress={() => {
                    setSearchInput('');
                    setSearchFocused(false);
                    setFilters({ ...filters, from: p.email });
                  }}
                >
                  <SenderAvatar name={p.name} email={p.email} size={20} />
                  <Text style={styles.recentSearchText} numberOfLines={1}>
                    {p.name && p.name !== p.email ? `${p.name} · ${p.email}` : p.email}
                  </Text>
                </Pressable>
              ))}
            </>
          )}
        </View>
      )}

      {hasActiveSearchOrFilter && (
        <View style={styles.filterChipsRow}>
          {storeSearchQuery ? (
            <FilterChip
              icon={<Search size={12} color={c.textSecondary} />}
              label={storeSearchQuery}
              onRemove={() => { setSearchInput(''); setSearchQuery(''); }}
            />
          ) : null}
          {(storeSearchQuery || activeFilterCount > 0) && (
            <FilterChip
              icon={<Folder size={12} color={c.textSecondary} />}
              label={
                folderScope === 'all'
                  ? t('email_list.scope_all_folders', 'All folders')
                  : folderScope === 'current'
                    ? t('email_list.scope_this_folder', 'This folder')
                    : scopeFolderName ?? ''
              }
              onPress={() => setFilterMenuOpen(true)}
            />
          )}
          {keywordFilterLabel ? (
            <FilterChip
              icon={<Tag size={12} color={c.textSecondary} />}
              label={keywordFilterLabel}
              onRemove={() => setFilterField('keyword', undefined)}
            />
          ) : null}
          {filters.from ? (
            <FilterChip label={`${t('advanced_search.from', 'From')}: ${filters.from}`} onRemove={() => setFilterField('from', undefined)} />
          ) : null}
          {filters.to ? (
            <FilterChip label={`${t('advanced_search.to', 'To')}: ${filters.to}`} onRemove={() => setFilterField('to', undefined)} />
          ) : null}
          {filters.subject ? (
            <FilterChip label={`${t('advanced_search.subject', 'Subject')}: ${filters.subject}`} onRemove={() => setFilterField('subject', undefined)} />
          ) : null}
          {filters.body ? (
            <FilterChip label={`${t('advanced_search.body', 'Body')}: ${filters.body}`} onRemove={() => setFilterField('body', undefined)} />
          ) : null}
          {filters.dateAfter ? (
            <FilterChip
              icon={<CalendarDays size={12} color={c.textSecondary} />}
              label={`${t('advanced_search.after', 'After')} ${filters.dateAfter}`}
              onRemove={() => setFilterField('dateAfter', undefined)}
            />
          ) : null}
          {filters.dateBefore ? (
            <FilterChip
              icon={<CalendarDays size={12} color={c.textSecondary} />}
              label={`${t('advanced_search.before', 'Before')} ${filters.dateBefore}`}
              onRemove={() => setFilterField('dateBefore', undefined)}
            />
          ) : null}
          {filters.isUnread !== undefined && (
            <FilterChip
              icon={filters.isUnread
                ? <MailIcon size={12} color={c.textSecondary} />
                : <MailOpen size={12} color={c.textSecondary} />}
              label={filters.isUnread ? t('email_list.unread', 'Unread') : t('advanced_search.read', 'Read')}
              onRemove={() => cycleTriStateTo('isUnread', undefined)}
            />
          )}
          {filters.isStarred !== undefined && (
            <FilterChip
              icon={<Star size={12} color={c.starred} fill={filters.isStarred ? c.starred : 'transparent'} />}
              label={filters.isStarred ? t('email_list.starred', 'Starred') : t('advanced_search.not_starred', 'Not starred')}
              onRemove={() => cycleTriStateTo('isStarred', undefined)}
            />
          )}
          {filters.hasAttachment !== undefined && (
            <FilterChip
              icon={<Paperclip size={12} color={c.textSecondary} />}
              label={filters.hasAttachment
                ? t('advanced_search.has_attachment', 'Has attachment')
                : t('advanced_search.no_attachment', 'No attachment')}
              onRemove={() => cycleTriStateTo('hasAttachment', undefined)}
            />
          )}
          <Pressable
            onPress={() => {
              setSearchInput('');
              clearSearchAndFilters();
            }}
            style={styles.clearAllButton}
            hitSlop={6}
          >
            <Text style={styles.clearAllText}>{t('advanced_search.clear', 'Clear')}</Text>
          </Pressable>
        </View>
      )}

      {canEmptyFolder && !selectionMode && (
        <View style={styles.emptyFolderBanner}>
          <Text style={styles.emptyFolderHint} numberOfLines={2}>
            {inJunk
              ? t('email_list.empty_folder.junk_hint', 'You can empty the Junk folder to permanently remove all messages.')
              : t('email_list.empty_folder.trash_hint', 'You can empty the Trash folder to permanently remove all messages.')}
          </Text>
          <Pressable onPress={handleEmptyFolder} disabled={emptying} style={styles.emptyFolderButton} hitSlop={6}>
            {emptying ? (
              <ActivityIndicator size="small" color={c.error} />
            ) : (
              <Text style={styles.emptyFolderButtonText}>{t('email_list.empty_folder.button', 'Empty folder')}</Text>
            )}
          </Pressable>
        </View>
      )}

      <OfflineBanner hint={emails.length > 0 ? t('email_list.showing_cached', 'Showing cached mail') : undefined} />

      {failedOps.length > 0 && (
        <View style={[styles.emptyFolderBanner, { borderColor: c.error }]}>
          <Text style={styles.emptyFolderHint} numberOfLines={2}>
            {t('email_list.outbox_failed', `${failedOps.length} changes could not be saved to the server.`, { count: failedOps.length })}
            {failedOps[0]?.lastError ? ` ${failedOps[0].lastError}` : ''}
          </Text>
          <Pressable onPress={() => { void retryFailedOps(); }} style={styles.emptyFolderButton} hitSlop={6}>
            <Text style={[styles.emptyFolderButtonText, { color: c.primary }]}>{t('common.retry', 'Retry')}</Text>
          </Pressable>
          <Pressable onPress={discardFailedOps} style={styles.emptyFolderButton} hitSlop={6}>
            <Text style={styles.emptyFolderButtonText}>{t('email_list.outbox_discard', 'Discard')}</Text>
          </Pressable>
        </View>
      )}

      {/* Email list */}
      {loading && emails.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={c.primary} />
          <Text style={styles.loadingText}>{t('email_list.loading', 'Loading emails...')}</Text>
        </View>
      ) : error && emails.length === 0 ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.errorText}>
            {networkOnline
              ? error
              : t('email_list.offline_nothing_cached', 'No connection. Showing nothing because no mail has been cached yet.')}
          </Text>
          <Pressable
            onPress={() => {
              // A failed first load left no folders behind (lazy provisioning,
              // #217): retry the mailbox fetch — refreshEmails() would return
              // immediately with no folder selected.
              if (mailboxes.length === 0 || !currentMailboxId) void fetchMailboxes();
              else void refreshEmails();
            }}
          >
            <Text style={styles.retryText}>{t('common.retry', 'Retry')}</Text>
          </Pressable>
        </View>
      ) : mailboxes.length === 0 ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>{t('email_list.no_mailboxes', 'No mailboxes found')}</Text>
          <Text style={styles.hintText}>
            {t('email_list.no_mailboxes_hint', 'Check that your JMAP account has mail capability.')}
          </Text>
          <Pressable onPress={() => { void fetchMailboxes(); }}>
            <Text style={styles.retryText}>{t('common.retry', 'Retry')}</Text>
          </Pressable>
        </View>
      ) : emails.length === 0 ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>
            {hasActiveSearchOrFilter
              ? t('email_list.no_search_results', 'No emails found')
              : t('email_list.no_emails_in', `No emails in ${headerTitle}`, { folder: headerTitle })}
          </Text>
          {currentMailbox && !hasActiveSearchOrFilter ? (
            <Text style={styles.hintText}>
              {currentMailbox.totalEmails} {t('email_list.total', 'total')} · {currentMailbox.unreadEmails} {t('email_list.unread', 'unread')}
            </Text>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={visibleEmails}
          keyExtractor={emailKeyExtractor}
          renderItem={renderEmailRow}
          // Without it FlatList gives its cells a new render function on each
          // of its own renders, and every mounted row re-renders with it.
          strictMode
          ItemSeparatorComponent={EmailRowSeparator}
          contentContainerStyle={styles.listContent}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.3}
          refreshing={loading}
          onRefresh={handleRefresh}
        />
      )}

      {/* Compose FAB - matches webmail mobile: PenSquare, h-14 w-14, rounded-full, shadow-lg */}
      <Pressable
        onPress={onComposePress}
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
      >
        <SquarePen size={24} color={c.background} />
      </Pressable>

      <SidebarDrawer visible={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <ListAttachmentOpener ref={attachmentOpenerRef} />

      <Modal
        visible={filterMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setFilterMenuOpen(false)}
      >
        <TouchableWithoutFeedback onPress={() => setFilterMenuOpen(false)}>
          <View style={styles.filterBackdrop}>
            <TouchableWithoutFeedback>
              <View style={styles.filterMenu}>
                <View style={styles.filterMenuHeader}>
                  <Text style={styles.filterMenuTitle}>Filter emails</Text>
                  <View style={styles.filterMenuHeaderActions}>
                    <Pressable
                      onPress={() => setFilters({})}
                      style={styles.filterMenuHeaderBtn}
                      hitSlop={6}
                    >
                      <RotateCcw size={12} color={c.textSecondary} />
                      <Text style={styles.filterMenuHeaderBtnText}>Clear</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setFilterMenuOpen(false)}
                      style={styles.filterMenuClose}
                      hitSlop={6}
                    >
                      <X size={16} color={c.textSecondary} />
                    </Pressable>
                  </View>
                </View>

                <ScrollView contentContainerStyle={styles.filterMenuBody} keyboardShouldPersistTaps="handled">
                  <View style={styles.filterFieldRow}>
                    <View style={styles.filterFieldHalf}>
                      <Text style={styles.filterFieldLabel}>From</Text>
                      <TextInput
                        value={filters.from ?? ''}
                        onChangeText={(v) => setFilterField('from', v)}
                        placeholder="sender@example.com"
                        placeholderTextColor={c.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={styles.filterFieldInput}
                      />
                    </View>
                    <View style={styles.filterFieldHalf}>
                      <Text style={styles.filterFieldLabel}>To</Text>
                      <TextInput
                        value={filters.to ?? ''}
                        onChangeText={(v) => setFilterField('to', v)}
                        placeholder="recipient@example.com"
                        placeholderTextColor={c.textMuted}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={styles.filterFieldInput}
                      />
                    </View>
                  </View>

                  <View>
                    <Text style={styles.filterFieldLabel}>{t('advanced_search.subject', 'Subject')}</Text>
                    <TextInput
                      value={filters.subject ?? ''}
                      onChangeText={(v) => setFilterField('subject', v)}
                      placeholder={t('advanced_search.subject_placeholder', 'Subject contains...')}
                      placeholderTextColor={c.textMuted}
                      style={styles.filterFieldInput}
                    />
                  </View>

                  <View>
                    <Text style={styles.filterFieldLabel}>{t('advanced_search.body', 'Body')}</Text>
                    <TextInput
                      value={filters.body ?? ''}
                      onChangeText={(v) => setFilterField('body', v)}
                      placeholder={t('advanced_search.body_placeholder', 'Body contains...')}
                      placeholderTextColor={c.textMuted}
                      style={styles.filterFieldInput}
                    />
                  </View>

                  {/* Folder scope (#788): all folders by default for a search,
                      the open folder, or one picked from the account's tree. */}
                  <View>
                    <Text style={styles.filterFieldLabel}>{t('advanced_search.folder', 'Folder')}</Text>
                    <View style={styles.filterToggleGroup}>
                      <ScopeChip
                        label={t('email_list.scope_all_folders', 'All folders')}
                        active={folderScope === 'all'}
                        onPress={() => setFolderScope('all')}
                      />
                      <ScopeChip
                        label={t('email_list.scope_this_folder', 'This folder')}
                        active={folderScope === 'current'}
                        onPress={() => setFolderScope('current')}
                      />
                      {scopedMailboxes
                        .filter((m) => m.id !== currentMailboxId)
                        .slice(0, 12)
                        .map((m) => (
                          <ScopeChip
                            key={m.id}
                            label={localizeMailboxName(m.role, m.name, t)}
                            active={folderScope === m.id}
                            onPress={() => setFolderScope(m.id)}
                          />
                        ))}
                    </View>
                  </View>

                  <View style={styles.filterFieldRow}>
                    <View style={styles.filterFieldHalf}>
                      <Text style={styles.filterFieldLabel}>After</Text>
                      <Pressable
                        style={styles.filterDateButton}
                        onPress={() => setDatePickerField('dateAfter')}
                      >
                        <CalendarDays size={14} color={c.textMuted} />
                        <Text style={[styles.filterDateText, !filters.dateAfter && styles.filterDateTextEmpty]}>
                          {filters.dateAfter || 'YYYY-MM-DD'}
                        </Text>
                        {filters.dateAfter ? (
                          <Pressable
                            onPress={() => setFilterField('dateAfter', undefined)}
                            hitSlop={6}
                          >
                            <X size={14} color={c.textMuted} />
                          </Pressable>
                        ) : null}
                      </Pressable>
                    </View>
                    <View style={styles.filterFieldHalf}>
                      <Text style={styles.filterFieldLabel}>Before</Text>
                      <Pressable
                        style={styles.filterDateButton}
                        onPress={() => setDatePickerField('dateBefore')}
                      >
                        <CalendarDays size={14} color={c.textMuted} />
                        <Text style={[styles.filterDateText, !filters.dateBefore && styles.filterDateTextEmpty]}>
                          {filters.dateBefore || 'YYYY-MM-DD'}
                        </Text>
                        {filters.dateBefore ? (
                          <Pressable
                            onPress={() => setFilterField('dateBefore', undefined)}
                            hitSlop={6}
                          >
                            <X size={14} color={c.textMuted} />
                          </Pressable>
                        ) : null}
                      </Pressable>
                    </View>
                  </View>

                  <View style={styles.filterToggleGroup}>
                    <TriToggle
                      icon={<Paperclip size={14} color={c.textSecondary} />}
                      label="Has attachment"
                      value={filters.hasAttachment}
                      onPress={() => cycleTriState('hasAttachment')}
                    />
                    <TriToggle
                      icon={<Star size={14} color={c.starred} fill={filters.isStarred ? c.starred : 'transparent'} />}
                      label="Starred"
                      value={filters.isStarred}
                      onPress={() => cycleTriState('isStarred')}
                    />
                    <TriToggle
                      icon={
                        filters.isUnread === false ? (
                          <MailOpen size={14} color={c.textSecondary} />
                        ) : (
                          <MailIcon size={14} color={c.textSecondary} />
                        )
                      }
                      label={filters.isUnread === false ? 'Read' : 'Unread'}
                      value={filters.isUnread}
                      onPress={() => cycleTriState('isUnread')}
                    />
                  </View>
                </ScrollView>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {datePickerField !== null && (() => {
        const current = filters[datePickerField];
        const initial = current ? new Date(current) : new Date();
        const onChange = (event: DateTimePickerEvent, selected?: Date) => {
          if (Platform.OS === 'android') {
            setDatePickerField(null);
          }
          if (event.type === 'dismissed' || !selected) return;
          const iso = selected.toISOString().slice(0, 10);
          setFilterField(datePickerField, iso);
        };
        if (Platform.OS === 'ios') {
          return (
            <Modal transparent animationType="fade" onRequestClose={() => setDatePickerField(null)}>
              <Pressable style={styles.pickerOverlay} onPress={() => setDatePickerField(null)} />
              <View style={styles.pickerSheet}>
                <View style={styles.pickerHeader}>
                  <Pressable onPress={() => setDatePickerField(null)} hitSlop={8}>
                    <Text style={styles.pickerDone}>Done</Text>
                  </Pressable>
                </View>
                <DateTimePicker
                  value={initial}
                  mode="date"
                  display="spinner"
                  onChange={onChange}
                />
              </View>
            </Modal>
          );
        }
        return (
          <DateTimePicker
            value={initial}
            mode="date"
            display="default"
            onChange={onChange}
          />
        );
      })()}

      {/* Every account's folders are offered: a move into another account's
          folder is a copy+delete through the blob (webmail 1.7.2). */}
      <MoveSheet
        visible={pendingMoveId !== null}
        onClose={() => setPendingMoveId(null)}
        mailboxes={mailboxes}
        currentMailboxId={currentMailboxId}
        onPick={(toId) => {
          const id = pendingMoveId;
          setPendingMoveId(null);
          if (id && currentMailboxId && toId !== currentMailboxId) {
            const ids = idsForRow(id);
            if (ids.length > 1) void moveEmailsToMailbox(ids, toId);
            else void moveToMailboxAction(id, currentMailboxId, toId);
          }
        }}
      />

      <MoveSheet
        visible={batchMoveOpen}
        onClose={() => setBatchMoveOpen(false)}
        mailboxes={mailboxes}
        currentMailboxId={currentMailboxId}
        onPick={handleBatchMovePick}
      />

      <TagSheet
        visible={tagSheetOpen}
        onClose={() => setTagSheetOpen(false)}
        keywords={keywordDefs}
        selectedEmails={selectedEmails}
        onToggle={handleBatchTagToggle}
      />

      <UndoSnackbar />
    </View>
  );
}

function FilterChip({
  icon,
  label,
  onRemove,
  onPress,
}: {
  icon?: React.ReactNode;
  label: string;
  /** Per-chip removal (webmail search-chips X). */
  onRemove?: () => void;
  onPress?: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable style={styles.chip} onPress={onPress} disabled={!onPress}>
      {icon}
      <Text style={styles.chipText} numberOfLines={1}>{label}</Text>
      {onRemove ? (
        <Pressable onPress={onRemove} hitSlop={8} style={styles.chipRemove}>
          <X size={11} color={c.textMuted} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function ScopeChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable onPress={onPress} style={[styles.triToggle, active && styles.triToggleOn]}>
      <Text style={[styles.triToggleText, active && styles.triToggleTextOn]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

function TriToggle({
  icon,
  label,
  value,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  value: boolean | undefined;
  onPress: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const state =
    value === true ? 'on' : value === false ? 'off' : 'unset';
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.triToggle,
        state === 'on' && styles.triToggleOn,
        state === 'off' && styles.triToggleOff,
      ]}
    >
      {icon}
      <Text
        style={[
          styles.triToggleText,
          state === 'on' && styles.triToggleTextOn,
          state === 'off' && styles.triToggleTextOff,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },

  // Header - matches web mobile-header: h-14 (56px), px-4, border-b
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    height: componentSizes.headerHeight,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    gap: spacing.md,
  },
  headerButton: {
    width: componentSizes.buttonLg, height: componentSizes.buttonLg, // h-11 w-11 = 44px
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.full,
  },
  headerTitle: { ...typography.h3, color: c.text, flexShrink: 1 }, // text-lg font-semibold
  headerLogo: {
    width: 28,
    height: 28,
  },

  // Search - matches web search bar styling
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    gap: spacing.sm,
  },
  checkboxButton: {
    width: componentSizes.buttonMd, height: componentSizes.buttonMd,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.xs,
  },
  searchInputArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    height: componentSizes.inputHeight, // h-10 = 40px
    backgroundColor: c.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    gap: spacing.sm,
  },
  searchInput: { flex: 1, ...typography.body, color: c.text },
  filterButton: {
    width: componentSizes.buttonMd, height: componentSizes.buttonMd,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.xs,
    position: 'relative',
  },
  filterButtonActive: {
    backgroundColor: c.accent,
  },
  filterBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  filterBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: c.primaryForeground,
    lineHeight: 14,
  },
  searchClearButton: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  filterChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    maxWidth: 200,
  },
  chipText: {
    ...typography.caption,
    color: c.textSecondary,
    flexShrink: 1,
  },
  chipRemove: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentSearches: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: c.popover,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    paddingVertical: spacing.xs,
  },
  recentSearchesTitle: {
    ...typography.caption,
    color: c.textMuted,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  recentSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    minHeight: 36,
    gap: spacing.sm,
  },
  recentSearchMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  recentSearchText: { ...typography.body, color: c.text, flexShrink: 1 },
  emptyFolderBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  emptyFolderHint: { ...typography.caption, color: c.textSecondary, flex: 1 },
  emptyFolderButton: { paddingHorizontal: spacing.sm, paddingVertical: 4 },
  emptyFolderButtonText: { ...typography.captionMedium, color: c.error },
  clearAllButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  clearAllText: {
    ...typography.captionMedium,
    color: c.primary,
  },
  filterBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  filterMenu: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '85%',
    backgroundColor: c.popover,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
  },
  filterMenuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  filterMenuTitle: {
    ...typography.bodySemibold,
    color: c.text,
  },
  filterMenuHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  filterMenuHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.xs,
  },
  filterMenuHeaderBtnText: {
    ...typography.caption,
    color: c.textSecondary,
  },
  filterMenuClose: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xs,
  },
  filterMenuBody: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  filterFieldRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  filterFieldHalf: { flex: 1 },
  filterFieldLabel: {
    ...typography.caption,
    color: c.textMuted,
    marginBottom: 4,
  },
  filterFieldInput: {
    ...typography.body,
    color: c.text,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    height: 32,
  },
  filterDateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    height: 32,
  },
  filterDateText: {
    ...typography.body,
    color: c.text,
    flex: 1,
  },
  filterDateTextEmpty: {
    color: c.textMuted,
  },
  filterToggleGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 4,
  },
  triToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.background,
  },
  triToggleOn: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderColor: 'rgba(59, 130, 246, 0.3)',
  },
  triToggleOff: {
    backgroundColor: c.muted,
    borderColor: c.border,
  },
  triToggleText: {
    ...typography.caption,
    color: c.textMuted,
  },
  triToggleTextOn: {
    color: c.primary,
  },
  triToggleTextOff: {
    color: c.textMuted,
    textDecorationLine: 'line-through',
  },
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  pickerSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: c.popover,
    paddingBottom: spacing.xl,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    borderColor: c.border,
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  pickerDone: {
    ...typography.bodyMedium,
    color: c.primary,
  },

  // Email list - matches web email-list-item
  listContent: { paddingBottom: 100 },
  emailRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,      // px-4 = 16px
    paddingVertical: spacing.md,        // py-3 = 12px (density-item-py)
    gap: spacing.md,                    // gap-3 = 12px (density-item-gap)
    borderBottomWidth: 1,
    borderBottomColor: c.border,   // border-b border-border
  },
  emailRowPressed: { backgroundColor: c.surface },
  emailRowSelected: { backgroundColor: c.selection },
  // Mirrors the webmail's unread indicator: an 8px filled circle at the row's
  // start edge, vertically centered (email-list-item.tsx, fill-unread). The
  // weight/color change alone is too subtle on some device fonts (#27).
  // `top` is set per row: the dot is anchored on the row's *first* line (top
  // padding + half an avatar), not on the row's midpoint, which would drop it
  // a full line below the checkbox and avatar it reads as a column with.
  unreadDot: {
    position: 'absolute',
    left: 4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: c.unread,
  },
  rowCheckboxWrap: {
    width: 16,
    height: componentSizes.avatarMd,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxIndeterminate: {
    width: 18,
    height: 18,
    borderRadius: radius.xs,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emailContent: { flex: 1, minWidth: 0 },
  emailHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  senderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flex: 1,
    marginRight: spacing.sm,
  },
  // Sender: text-sm, font-medium (read) / font-bold (unread)
  emailFrom: { ...typography.bodyMedium, color: c.textSecondary, flexShrink: 1 },
  timeAndTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  threadBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  threadBadgeText: { ...typography.caption, color: c.textMuted },
  // Date: text-xs (12px), tabular-nums
  emailDate: { ...typography.caption, color: c.textMuted },
  subjectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  // Subject: text-sm (14px), font-semibold (unread) / font-normal (read)
  emailSubject: { ...typography.body, color: c.text, flex: 1 },
  // Preview: text-sm, leading-relaxed, line-clamp-2
  emailPreview: { ...typography.body, color: c.textSecondary, lineHeight: 20, opacity: 0.8 },
  // Unread state: text foreground + font-bold
  textUnread: { fontWeight: '600', color: c.text },
  textBold: { fontWeight: '700' },
  // Tag pill: text-[10px], rounded-full, px-1.5 py-0.5, gap-1
  tagPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,   // px-1.5
    paddingVertical: 2,     // py-0.5
    borderRadius: radius.full,
    gap: 4,                 // gap-1
  },
  tagDot: {
    width: componentSizes.tagDot,
    height: componentSizes.tagDot,
    borderRadius: componentSizes.tagDot / 2,
  },
  tagText: { ...typography.small, fontWeight: '500' },
  separator: { height: 0 }, // borders are on rows now

  // Compose FAB - matches webmail: absolute bottom-4 right-4, h-14 w-14, rounded-full, bg-primary, shadow-lg
  fab: {
    position: 'absolute',
    right: spacing.lg,               // right-4
    bottom: spacing.lg,              // bottom-4
    width: componentSizes.fab,       // 56px (h-14)
    height: componentSizes.fab,      // 56px (w-14)
    borderRadius: radius.full,       // rounded-full (circle)
    backgroundColor: c.text,    // white - matches webmail mobile FAB
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 4.65,
    zIndex: 40,                      // z-40
  },
  fabPressed: {
    opacity: 0.9,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
  },
  loadingText: {
    ...typography.body,
    color: c.textMuted,
  },
  errorText: {
    ...typography.body,
    color: c.error,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  retryText: {
    ...typography.bodyMedium,
    color: c.primary,
    marginTop: spacing.sm,
  },
  hintText: {
    ...typography.caption,
    color: c.textMuted,
    marginTop: spacing.xs,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  });
}

export type { EmailListScreenProps };
