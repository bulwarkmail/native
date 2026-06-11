import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator,
  Modal, useWindowDimensions, Animated, Easing, Alert, FlatList,
} from 'react-native';
import type { NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ArrowLeft, Star, Trash2, MoreVertical, Reply, ReplyAll, Forward,
  ChevronLeft, ChevronRight, Paperclip, Archive, Mail, MailOpen,
  FolderInput, ShieldAlert, ShieldCheck, X, Check,
  Code, Download, Tag,
} from 'lucide-react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import EmailBodyView from '../components/EmailBodyView';
import { CalendarInvitationBanner } from '../components/email/CalendarInvitationBanner';
import SenderAvatar from '../components/SenderAvatar';
import { MoveSheet } from '../components/MoveSheet';
import { useEmailStore } from '../stores/email-store';
import {
  useSettingsStore,
  normalizeBottomQuickActions,
  REPLY_QUICK_ACTIONS,
  type QuickAction,
} from '../stores/settings-store';
import { setEmailKeywords } from '../api/email';
import { shareEmailEml, shareAttachment, downloadAttachment } from '../lib/email-export';
import { useKeywordsStore, keywordToken, type KeywordDef } from '../stores/keywords-store';
import { useSheetDrag } from '../lib/use-sheet-drag';
import type { Email, Mailbox } from '../api/types';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'EmailThread'>;

function formatHeaderDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function plainTextBody(email: Email): string {
  const textPart = email.textBody?.[0];
  if (textPart?.partId && email.bodyValues?.[textPart.partId]?.value) {
    return email.bodyValues[textPart.partId].value;
  }
  return email.preview ?? '';
}

export default function EmailThreadScreen({ route, navigation }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { jmapAccountId } = route.params;
  // The displayed email is tracked in local state (not a route param) so that
  // swiping / Prev-Next can switch messages in place without remounting the
  // screen — which is what produced the loading flash on every change.
  const [activeEmailId, setActiveEmailId] = React.useState(route.params.emailId);
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const getEmailDetail = useEmailStore((s) => s.getEmailDetail);
  const markRead = useEmailStore((s) => s.markRead);
  const deleteEmail = useEmailStore((s) => s.deleteEmail);
  const moveToMailbox = useEmailStore((s) => s.moveToMailbox);
  const archiveEmailAction = useEmailStore((s) => s.archiveEmail);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const currentMailboxId = useEmailStore((s) => s.currentMailboxId);
  const emails = useEmailStore((s) => s.emails);

  const currentIndex = emails.findIndex((e) => e.id === activeEmailId);
  const prevEmail = currentIndex > 0 ? emails[currentIndex - 1] : null;
  const nextEmail = currentIndex >= 0 && currentIndex < emails.length - 1 ? emails[currentIndex + 1] : null;

  const [error, setError] = React.useState<string | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = React.useState(false);
  const [moveMenuOpen, setMoveMenuOpen] = React.useState(false);
  const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
  const [downloadingBlobId, setDownloadingBlobId] = React.useState<string | null>(null);

  // In-memory cache of fetched message details keyed by id. This is the single
  // source of truth for every rendered pane: the active message *and* its
  // prefetched neighbours all read their detail from here, so a swipe lands on
  // ready content with no spinner and no late content-swap. `cacheVersion` is
  // bumped whenever an entry changes so the panes re-render.
  const detailCache = React.useRef(new Map<string, Email>()).current;
  const [cacheVersion, setCacheVersion] = React.useState(0);
  const bumpCache = React.useCallback(() => setCacheVersion((v) => v + 1), []);
  const email = React.useMemo(
    () => detailCache.get(activeEmailId) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeEmailId, cacheVersion, detailCache],
  );

  // --- Pager -------------------------------------------------------------
  // The pager is a horizontal, page-snapping FlatList over the mailbox's
  // `emails`. Native scroll provides the swipe + snap (and plays nicely with
  // each pane's vertical body scroll); Prev/Next scroll programmatically. When
  // scrolling settles, the centred page's id becomes `activeEmailId`, which is
  // what the toolbar and action handlers operate on.
  const listRef = React.useRef<FlatList<Email>>(null);
  // The page to open on mount — the entry point arrives as a route param, so
  // capture its index once.
  const initialIndexRef = React.useRef(
    Math.max(0, emails.findIndex((e) => e.id === route.params.emailId)),
  );

  // Coalesced detail fetch: stores the result in the shared cache and bumps the
  // version so every mounted pane (and the toolbar) re-reads it. Concurrent
  // calls for the same id share a single in-flight request.
  const inFlight = React.useRef(new Map<string, Promise<Email | null>>()).current;
  const ensureDetail = React.useCallback((id: string): Promise<Email | null> => {
    const pending = inFlight.get(id);
    if (pending) return pending;
    const p = getEmailDetail(id, jmapAccountId)
      .then((fetched) => { detailCache.set(id, fetched); bumpCache(); return fetched; })
      .catch(() => detailCache.get(id) ?? null)
      .finally(() => { inFlight.delete(id); });
    inFlight.set(id, p);
    return p;
  }, [getEmailDetail, jmapAccountId, detailCache, bumpCache, inFlight]);

  // Slide to a page by index and reflect it in the toolbar immediately; a swipe
  // that settles on the same page confirms the same id via onMomentumEnd.
  const goToIndex = React.useCallback((index: number) => {
    if (index < 0 || index >= emails.length) return;
    listRef.current?.scrollToOffset({ offset: index * windowWidth, animated: true });
    const target = emails[index];
    if (target) setActiveEmailId(target.id);
  }, [emails, windowWidth]);

  // Adopt the centred page as the active message once a swipe settles.
  const onMomentumEnd = React.useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / windowWidth);
    const target = emails[index];
    if (target && target.id !== activeEmailId) setActiveEmailId(target.id);
  }, [emails, windowWidth, activeEmailId]);

  // Page offsets are in window-width units, so a rotation / resize invalidates
  // the scroll position — re-centre the active page after the width changes.
  React.useLayoutEffect(() => {
    const index = emails.findIndex((e) => e.id === activeEmailId);
    if (index >= 0) listRef.current?.scrollToOffset({ offset: index * windowWidth, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowWidth]);

  const mailAttachmentAction = useSettingsStore((s) => s.mailAttachmentAction);
  const attachmentPosition = useSettingsStore((s) => s.attachmentPosition);
  const markAsReadDelay = useSettingsStore((s) => s.markAsReadDelay);
  const hideInlineImageAttachments = useSettingsStore((s) => s.hideInlineImageAttachments);
  const bottomQuickActionsRaw = useSettingsStore((s) => s.bottomQuickActions);
  const bottomActions = React.useMemo(
    () => normalizeBottomQuickActions(bottomQuickActionsRaw),
    [bottomQuickActionsRaw],
  );
  // Any reply-family action the user pulled out of the bottom bar is surfaced
  // in the top toolbar so it stays reachable.
  const relocatedActions = React.useMemo(
    () => REPLY_QUICK_ACTIONS.filter((a) => !bottomActions.includes(a)),
    [bottomActions],
  );

  const onPressAttachment = React.useCallback(
    async (target: Email, blobId: string, name: string | undefined, type: string | undefined) => {
      if (downloadingBlobId) return;
      setDownloadingBlobId(blobId);
      try {
        if (mailAttachmentAction === 'download') {
          await downloadAttachment(blobId, name, type, target);
        } else {
          await shareAttachment(blobId, name, type, target);
        }
      } catch (e) {
        Alert.alert('Download failed', e instanceof Error ? e.message : String(e));
      } finally {
        setDownloadingBlobId(null);
      }
    },
    [downloadingBlobId, mailAttachmentAction],
  );
  const keywordDefs = useKeywordsStore((s) => s.keywords);
  const hydrateKeywords = useKeywordsStore((s) => s.hydrate);
  const keywordsHydrated = useKeywordsStore((s) => s.hydrated);
  React.useEffect(() => { if (!keywordsHydrated) void hydrateKeywords(); }, [keywordsHydrated, hydrateKeywords]);

  React.useEffect(() => {
    let cancelled = false;
    let readTimer: ReturnType<typeof setTimeout> | null = null;
    // Refresh the active message — a cached copy (the pane may have fetched it,
    // or it was visited before) renders immediately while this lands. Then mark
    // it read per the user's delay. The pane itself fetches its own detail, so
    // ensureDetail here usually rides the same in-flight request.
    setError(null);
    void (async () => {
      const fetched = await ensureDetail(activeEmailId);
      if (cancelled) return;
      if (!fetched) {
        // Only surface an error if there's nothing cached to show.
        if (!detailCache.has(activeEmailId)) setError('Failed to load email');
        return;
      }
      if (!fetched.keywords?.$seen) {
        if (markAsReadDelay > 0) {
          readTimer = setTimeout(() => {
            if (!cancelled) void markRead(activeEmailId, jmapAccountId);
          }, markAsReadDelay);
        } else {
          void markRead(activeEmailId, jmapAccountId);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (readTimer) clearTimeout(readTimer);
    };
  }, [activeEmailId, ensureDetail, markRead, markAsReadDelay, jmapAccountId, detailCache]);

  const starred = !!email?.keywords?.$flagged;
  const unread = !!email && !email.keywords?.$seen;

  const archiveMailbox = React.useMemo(
    () => mailboxes.find((m) => m.role === 'archive'),
    [mailboxes],
  );
  const junkMailbox = React.useMemo(
    () => mailboxes.find((m) => m.role === 'junk' || m.role === 'spam'),
    [mailboxes],
  );
  const inboxMailbox = React.useMemo(
    () => mailboxes.find((m) => m.role === 'inbox'),
    [mailboxes],
  );
  const isInJunk = !!(junkMailbox && email?.mailboxIds?.[junkMailbox.id]);

  // Optimistically write a message's keywords into the cache (the single source
  // of truth for every pane) and bump the version so the panes re-render.
  const updateLocalKeywords = (id: string, next: Record<string, boolean>) => {
    const prev = detailCache.get(id);
    if (!prev) return;
    detailCache.set(id, { ...prev, keywords: next });
    bumpCache();
  };

  const onToggleKeyword = (token: string) => {
    if (!email) return;
    const next = { ...email.keywords };
    if (next[token]) delete next[token];
    else next[token] = true;
    updateLocalKeywords(email.id, next);
    void setEmailKeywords(email.id, next);
  };

  // Toggle the star on a specific message — used both by the toolbar (current
  // message) and by each pane's own subject star.
  const toggleStarFor = React.useCallback((target: Email) => {
    const next = { ...target.keywords };
    if (next.$flagged) delete next.$flagged;
    else next.$flagged = true;
    const prev = detailCache.get(target.id);
    if (prev) { detailCache.set(target.id, { ...prev, keywords: next }); bumpCache(); }
    void setEmailKeywords(target.id, next);
  }, [detailCache, bumpCache]);

  const onToggleStar = () => { if (email) toggleStarFor(email); };

  const onToggleUnread = () => {
    if (!email) return;
    if (unread) {
      void markRead(email.id);
      updateLocalKeywords(email.id, { ...email.keywords, $seen: true });
    } else {
      const next = { ...email.keywords };
      delete next.$seen;
      updateLocalKeywords(email.id, next);
      void setEmailKeywords(email.id, next);
    }
  };

  const onDelete = () => {
    if (!email || !currentMailboxId) return;
    const trash = mailboxes.find((m) => m.role === 'trash');
    if (!trash) return;
    void deleteEmail(email.id, trash.id, currentMailboxId);
    navigation.goBack();
  };

  const onArchive = () => {
    if (!email || !currentMailboxId || !archiveMailbox) return;
    if (currentMailboxId === archiveMailbox.id) return;
    void archiveEmailAction(email.id);
    navigation.goBack();
  };

  const onToggleSpam = () => {
    if (!email || !currentMailboxId) return;
    setMoreMenuOpen(false);
    if (isInJunk) {
      const target = inboxMailbox ?? mailboxes.find((m) => m.id !== currentMailboxId);
      if (!target) return;
      void moveToMailbox(email.id, currentMailboxId, target.id);
    } else {
      if (!junkMailbox) return;
      void moveToMailbox(email.id, currentMailboxId, junkMailbox.id);
    }
    navigation.goBack();
  };

  const onMoveToMailbox = (toId: string) => {
    if (!email || !currentMailboxId || toId === currentMailboxId) return;
    setMoveMenuOpen(false);
    setMoreMenuOpen(false);
    void moveToMailbox(email.id, currentMailboxId, toId);
    navigation.goBack();
  };

  const navigateCompose = (mode: 'reply' | 'replyAll' | 'forward') => {
    if (!email) return;
    const from = email.from?.[0];
    if (!from && mode !== 'forward') return;
    navigation.navigate('Compose', {
      mode,
      replyTo: {
        from: from ?? { email: '' },
        to: email.to,
        cc: email.cc,
        subject: email.subject ?? '',
        body: plainTextBody(email),
        receivedAt: email.receivedAt,
        inReplyTo: email.id,
      },
    });
  };

  // Registry of every action that can live in the bottom quick-action bar (or
  // be relocated to the top toolbar). `icon` is a factory so the same action
  // can render at the toolbar (18px) and bottom-bar (20px) sizes.
  const quickActionRegistry: Record<
    QuickAction,
    { label: string; icon: (size: number, color: string) => React.ReactNode; onPress: () => void; available: boolean }
  > = {
    reply: {
      label: 'Reply',
      icon: (s, col) => <Reply size={s} color={col} />,
      onPress: () => navigateCompose('reply'),
      available: true,
    },
    replyAll: {
      label: 'Reply All',
      icon: (s, col) => <ReplyAll size={s} color={col} />,
      onPress: () => navigateCompose('replyAll'),
      available: true,
    },
    forward: {
      label: 'Forward',
      icon: (s, col) => <Forward size={s} color={col} />,
      onPress: () => navigateCompose('forward'),
      available: true,
    },
    delete: {
      label: 'Delete',
      icon: (s, col) => <Trash2 size={s} color={col} />,
      onPress: onDelete,
      available: true,
    },
    archive: {
      label: 'Archive',
      icon: (s, col) => <Archive size={s} color={col} />,
      onPress: onArchive,
      available: !!archiveMailbox && currentMailboxId !== archiveMailbox?.id,
    },
    markUnread: {
      label: unread ? 'Read' : 'Unread',
      icon: (s, col) => (unread ? <MailOpen size={s} color={col} /> : <Mail size={s} color={col} />),
      onPress: onToggleUnread,
      available: true,
    },
    star: {
      label: starred ? 'Unstar' : 'Star',
      icon: (s, col) => (
        <Star size={s} color={starred ? c.starred : col} fill={starred ? c.starred : 'transparent'} />
      ),
      onPress: onToggleStar,
      available: true,
    },
    move: {
      label: 'Move',
      icon: (s, col) => <FolderInput size={s} color={col} />,
      onPress: () => setMoveMenuOpen(true),
      available: mailboxes.length > 0,
    },
    spam: {
      label: isInJunk ? 'Not spam' : 'Spam',
      icon: (s, col) =>
        isInJunk ? <ShieldCheck size={s} color={c.success} /> : <ShieldAlert size={s} color={col} />,
      onPress: onToggleSpam,
      available: !!junkMailbox || isInJunk,
    },
    tag: {
      label: 'Tag',
      icon: (s, col) => <Tag size={s} color={col} />,
      onPress: () => setTagMenuOpen(true),
      available: keywordDefs.length > 0,
    },
  };

  const bottomBarHeight = 60 + Math.max(insets.bottom, 4);

  // Show extras in priority order. Each toolbar button is ~64px wide (icon+label+padding);
  // back arrow + side padding reserves ~64px. Drop optional buttons on narrow screens.
  const showMarkUnread = windowWidth >= 340;
  const showArchive = windowWidth >= 400 && !!archiveMailbox;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Toolbar */}
      <View style={styles.toolbar}>
        <Pressable onPress={() => navigation.goBack()} style={styles.toolbarBack} hitSlop={8}>
          <ArrowLeft size={22} color={c.text} />
        </Pressable>
        <View style={styles.toolbarActions}>
          {relocatedActions.map((id) => {
            const def = quickActionRegistry[id];
            return (
              <ToolbarButton
                key={id}
                icon={def.icon(18, c.textSecondary)}
                label={def.label}
                onPress={def.onPress}
              />
            );
          })}
          <ToolbarButton
            icon={<Trash2 size={18} color={c.textSecondary} />}
            label="Delete"
            onPress={onDelete}
          />
          {showArchive && (
            <ToolbarButton
              icon={<Archive size={18} color={c.textSecondary} />}
              label="Archive"
              onPress={onArchive}
            />
          )}
          {showMarkUnread && (
            <ToolbarButton
              icon={
                unread ? (
                  <MailOpen size={18} color={c.textSecondary} />
                ) : (
                  <Mail size={18} color={c.textSecondary} />
                )
              }
              label={unread ? 'Read' : 'Unread'}
              onPress={onToggleUnread}
            />
          )}
          <ToolbarButton
            icon={
              <Star
                size={18}
                color={starred ? c.starred : c.textSecondary}
                fill={starred ? c.starred : 'transparent'}
              />
            }
            label="Star"
            onPress={onToggleStar}
          />
          <ToolbarButton
            icon={<MoreVertical size={18} color={c.textSecondary} />}
            label="More"
            onPress={() => setMoreMenuOpen(true)}
          />
        </View>
      </View>

      {error && !email ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <>
          {/* Pager: a horizontal page-snapping list over the mailbox. Each
              page is the full-width pane for one message; native scroll slides
              between them and onMomentumEnd reports the settled page. */}
          <FlatList
            ref={listRef}
            style={styles.pagerViewport}
            data={emails}
            extraData={cacheVersion}
            keyExtractor={(item) => item.id}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={initialIndexRef.current}
            getItemLayout={(_, index) => ({ length: windowWidth, offset: windowWidth * index, index })}
            windowSize={3}
            initialNumToRender={1}
            maxToRenderPerBatch={2}
            removeClippedSubviews
            onMomentumScrollEnd={onMomentumEnd}
            renderItem={({ item, index }) => (
              <View style={{ width: windowWidth }}>
                <EmailPane
                  id={item.id}
                  email={detailCache.get(item.id) ?? null}
                  ensureDetail={ensureDetail}
                  c={c}
                  styles={styles}
                  bottomBarHeight={bottomBarHeight}
                  attachmentPosition={attachmentPosition}
                  hideInlineImageAttachments={hideInlineImageAttachments}
                  downloadingBlobId={downloadingBlobId}
                  onToggleStar={toggleStarFor}
                  onPressAttachment={onPressAttachment}
                  onSwipe={(dir) => goToIndex(dir === 'next' ? index + 1 : index - 1)}
                />
              </View>
            )}
          />

          {/* Bottom action bar */}
          <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 4) }]}>
            <BottomBarButton
              icon={<ChevronLeft size={20} color={c.textMuted} />}
              label="Prev"
              onPress={prevEmail ? () => goToIndex(currentIndex - 1) : undefined}
              disabled={!prevEmail}
            />
            {bottomActions.map((id) => {
              const def = quickActionRegistry[id];
              return (
                <BottomBarButton
                  key={id}
                  icon={def.icon(20, c.textSecondary)}
                  label={def.label}
                  onPress={def.available ? def.onPress : undefined}
                  disabled={!def.available}
                />
              );
            })}
            <BottomBarButton
              icon={<ChevronRight size={20} color={c.textMuted} />}
              label="Next"
              onPress={nextEmail ? () => goToIndex(currentIndex + 1) : undefined}
              disabled={!nextEmail}
            />
          </View>
        </>
      )}

      <MoreMenuSheet
        visible={moreMenuOpen}
        onClose={() => setMoreMenuOpen(false)}
        unread={unread}
        canArchive={!!archiveMailbox && currentMailboxId !== archiveMailbox?.id}
        canMarkUnread={true}
        canMove={mailboxes.length > 0}
        showSpam={!!junkMailbox || isInJunk}
        isInJunk={isInJunk}
        canViewSource={!!email?.blobId}
        canExport={!!email?.blobId}
        canTag={keywordDefs.length > 0}
        onArchive={() => { setMoreMenuOpen(false); onArchive(); }}
        onToggleUnread={() => { setMoreMenuOpen(false); onToggleUnread(); }}
        onMove={() => { setMoreMenuOpen(false); setMoveMenuOpen(true); }}
        onTag={() => { setMoreMenuOpen(false); setTagMenuOpen(true); }}
        onToggleSpam={onToggleSpam}
        onViewSource={() => {
          setMoreMenuOpen(false);
          if (email?.blobId) {
            navigation.navigate('EmailSource', {
              emailId: email.id,
              blobId: email.blobId,
              subject: email.subject,
            });
          }
        }}
        onExport={async () => {
          setMoreMenuOpen(false);
          if (!email?.blobId) return;
          try {
            await shareEmailEml(email.blobId, email);
          } catch (e) {
            Alert.alert('Export failed', e instanceof Error ? e.message : String(e));
          }
        }}
      />

      <MoveSheet
        visible={moveMenuOpen}
        onClose={() => setMoveMenuOpen(false)}
        mailboxes={mailboxes}
        currentMailboxId={currentMailboxId}
        onPick={onMoveToMailbox}
      />

      <TagMenuSheet
        visible={tagMenuOpen}
        onClose={() => setTagMenuOpen(false)}
        keywords={keywordDefs}
        activeKeywords={email?.keywords ?? {}}
        onToggle={onToggleKeyword}
      />
    </SafeAreaView>
  );
}

interface EmailPaneProps {
  id: string;
  email: Email | null;
  ensureDetail: (id: string) => Promise<Email | null>;
  c: ThemePalette;
  styles: ReturnType<typeof makeStyles>;
  bottomBarHeight: number;
  attachmentPosition: 'beside-sender' | 'below-header';
  hideInlineImageAttachments: boolean;
  downloadingBlobId: string | null;
  onToggleStar: (email: Email) => void;
  onPressAttachment: (email: Email, blobId: string, name: string | undefined, type: string | undefined) => void;
  onSwipe: (direction: 'prev' | 'next') => void;
}

// One swipeable page: the scrollable subject / sender / attachments / body for a
// single message. The pager keeps three of these mounted (prev, current, next)
// so a swipe slides ready content into view. Each pane owns its own vertical
// scroll position and "show all attachments" toggle, and renders directly from
// the email passed to it — neighbours show real content, not a placeholder.
function EmailPane({
  id, email, ensureDetail, c, styles, bottomBarHeight, attachmentPosition,
  hideInlineImageAttachments, downloadingBlobId, onToggleStar, onPressAttachment, onSwipe,
}: EmailPaneProps) {
  const [attachmentsExpanded, setAttachmentsExpanded] = React.useState(false);

  // Each pane owns loading its own message: when the list mounts this page and
  // its detail isn't cached yet, fetch it (coalesced upstream). The shared
  // cache then re-renders the pane with real content.
  React.useEffect(() => {
    if (!email) void ensureDetail(id);
  }, [id, email, ensureDetail]);

  // Detail not fetched yet. Show a skeleton of the pane layout instead of a
  // spinner so the transition into real content doesn't jump.
  if (!email) {
    return <EmailPaneSkeleton styles={styles} />;
  }

  const from = email.from?.[0];
  const starred = !!email.keywords?.$flagged;
  const subject = email.subject || '(no subject)';

  const renderAttachments = () => {
    const all = email.attachments;
    if (!all || all.length === 0) return null;
    // hideInlineImageAttachments: drop chips for images already shown inline
    // in the body (any image attachment with a cid:). Non-image inline
    // attachments stay visible because the user wouldn't see them otherwise.
    const atts = hideInlineImageAttachments
      ? all.filter((att) => !(att.cid && (att.type ?? '').startsWith('image/')))
      : all;
    if (atts.length === 0) return null;
    const visible = attachmentsExpanded ? atts : atts.slice(0, 3);
    return (
      <View style={styles.attachmentsBlock}>
        <View style={styles.attachmentsRow}>
          {visible.map((att, idx) => {
            const isDownloading = downloadingBlobId === att.blobId;
            return (
              <Pressable
                key={att.blobId ?? idx}
                style={({ pressed }) => [
                  styles.attachmentChip,
                  pressed && styles.attachmentChipPressed,
                ]}
                onPress={() => onPressAttachment(email, att.blobId, att.name, att.type)}
                disabled={!!downloadingBlobId}
              >
                {isDownloading ? (
                  <ActivityIndicator size="small" color={c.textMuted} />
                ) : (
                  <Paperclip size={14} color={c.textMuted} />
                )}
                <Text style={styles.attachmentName} numberOfLines={1}>
                  {att.name || 'attachment'}
                </Text>
                <Text style={styles.attachmentSize}>{formatSize(att.size)}</Text>
                <Download size={14} color={c.textMuted} />
              </Pressable>
            );
          })}
        </View>
        {atts.length > 3 && (
          <Pressable
            onPress={() => setAttachmentsExpanded((v) => !v)}
            style={({ pressed }) => [
              styles.attachmentsToggle,
              pressed && styles.attachmentsTogglePressed,
            ]}
            hitSlop={6}
          >
            <Text style={styles.attachmentsToggleText}>
              {attachmentsExpanded ? 'Show less' : `Show all (${atts.length})`}
            </Text>
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={{ paddingBottom: bottomBarHeight + spacing.lg }}
    >
      {/* Subject block */}
      <View style={styles.subjectBlock}>
        <View style={styles.subjectRow}>
          <View style={styles.subjectMain}>
            <Pressable onPress={() => onToggleStar(email)} hitSlop={8} style={styles.subjectStar}>
              <Star
                size={18}
                color={starred ? c.starred : c.textMuted}
                fill={starred ? c.starred : 'transparent'}
              />
            </Pressable>
            <Text style={styles.subjectText}>{subject}</Text>
          </View>
          <View style={styles.subjectMeta}>
            <Text style={styles.subjectDate}>{formatHeaderDate(email.receivedAt)}</Text>
            {email.size > 0 && (
              <Text style={styles.subjectSize}>{formatSize(email.size)}</Text>
            )}
          </View>
        </View>
      </View>

      {/* Sender info */}
      <View style={styles.senderBlock}>
        <View style={styles.senderRow}>
          <SenderAvatar
            name={from?.name}
            email={from?.email}
            size={componentSizes.avatarMd}
          />
          <View style={styles.senderInfo}>
            <Text style={styles.senderName} numberOfLines={1}>
              {from?.name || from?.email || 'Unknown sender'}
            </Text>
            {from?.name && from?.email ? (
              <Text style={styles.senderEmail} numberOfLines={1}>{from.email}</Text>
            ) : null}
            <Text style={styles.senderRecipients} numberOfLines={1}>
              <Text style={styles.senderRecipientsLabel}>to </Text>
              {email.to?.map((t) => t.name || t.email).join(', ') || '-'}
            </Text>
          </View>
        </View>
        {attachmentPosition === 'beside-sender' && renderAttachments()}
      </View>

      {/* Attachments chips (full-width below header) */}
      {attachmentPosition === 'below-header' && renderAttachments()}

      {/* Calendar invitation (auto-detected .ics) */}
      <CalendarInvitationBanner email={email} />

      {/* Body */}
      <View style={styles.bodyBlock}>
        <EmailBodyView email={email} senderEmail={from?.email} onSwipe={onSwipe} />
      </View>
    </ScrollView>
  );
}

// Placeholder mimicking the pane layout (subject, sender, body lines) shown
// while a message's detail is loading. One pulsing opacity over static bones
// keeps it cheap enough to also sit in the off-screen neighbour panes.
function EmailPaneSkeleton({ styles }: { styles: ReturnType<typeof makeStyles> }) {
  const pulse = React.useRef(new Animated.Value(0.55)).current;
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.55, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const bodyLineWidths = ['92%', '100%', '85%', '96%', '60%', '88%', '74%', '40%'] as const;

  return (
    <Animated.View style={[styles.scroll, { opacity: pulse }]}>
      <View style={styles.subjectBlock}>
        <View style={[styles.skeletonBone, { height: 20, width: '78%' }]} />
        <View style={[styles.skeletonBone, { height: 12, width: '36%', marginTop: spacing.sm }]} />
      </View>
      <View style={styles.senderBlock}>
        <View style={styles.senderRow}>
          <View style={styles.skeletonAvatar} />
          <View style={styles.senderInfo}>
            <View style={[styles.skeletonBone, { height: 14, width: '55%' }]} />
            <View style={[styles.skeletonBone, { height: 11, width: '70%', marginTop: 6 }]} />
            <View style={[styles.skeletonBone, { height: 11, width: '45%', marginTop: 6 }]} />
          </View>
        </View>
      </View>
      <View style={styles.skeletonBody}>
        {bodyLineWidths.map((w, i) => (
          <View key={i} style={[styles.skeletonBone, { height: 12, width: w }]} />
        ))}
      </View>
    </Animated.View>
  );
}

interface MoreMenuSheetProps {
  visible: boolean;
  onClose: () => void;
  unread: boolean;
  canArchive: boolean;
  canMarkUnread: boolean;
  canMove: boolean;
  canTag: boolean;
  showSpam: boolean;
  isInJunk: boolean;
  canViewSource: boolean;
  canExport: boolean;
  onArchive: () => void;
  onToggleUnread: () => void;
  onMove: () => void;
  onTag: () => void;
  onToggleSpam: () => void;
  onViewSource: () => void;
  onExport: () => void;
}

function MoreMenuSheet({
  visible, onClose, unread, canArchive, canMarkUnread, canMove, canTag,
  showSpam, isInJunk, canViewSource, canExport,
  onArchive, onToggleUnread, onMove, onTag, onToggleSpam, onViewSource, onExport,
}: MoreMenuSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const slideY = React.useRef(new Animated.Value(400)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({ slideY, closedY: 400, onClose });

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 400, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, overlayOpacity]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.sheetOverlay, { opacity: overlayOpacity }]}>
        <Pressable style={styles.sheetOverlayPress} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom, spacing.md), transform: [{ translateY: slideY }] },
        ]}
      >
        <View {...dragHandlers}>
          <View style={styles.sheetHandleHit}>
            <View style={styles.sheetHandle} />
          </View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>More actions</Text>
            <Pressable onPress={onClose} hitSlop={8} style={styles.sheetClose}>
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
        {canArchive && (
          <MoreMenuItem
            icon={<Archive size={18} color={c.textSecondary} />}
            label="Archive"
            onPress={onArchive}
          />
        )}
        {canMarkUnread && (
          <MoreMenuItem
            icon={
              unread ? (
                <MailOpen size={18} color={c.textSecondary} />
              ) : (
                <Mail size={18} color={c.textSecondary} />
              )
            }
            label={unread ? 'Mark as read' : 'Mark as unread'}
            onPress={onToggleUnread}
          />
        )}
        {canMove && (
          <MoreMenuItem
            icon={<FolderInput size={18} color={c.textSecondary} />}
            label="Move to folder…"
            onPress={onMove}
            trailing={<ChevronRight size={16} color={c.textMuted} />}
          />
        )}
        {canTag && (
          <MoreMenuItem
            icon={<Tag size={18} color={c.textSecondary} />}
            label="Tag…"
            onPress={onTag}
            trailing={<ChevronRight size={16} color={c.textMuted} />}
          />
        )}
        {showSpam && (
          <MoreMenuItem
            icon={
              isInJunk ? (
                <ShieldCheck size={18} color={c.success} />
              ) : (
                <ShieldAlert size={18} color={c.error} />
              )
            }
            label={isInJunk ? 'Not spam' : 'Mark as spam'}
            onPress={onToggleSpam}
          />
        )}
        {canViewSource && (
          <MoreMenuItem
            icon={<Code size={18} color={c.textSecondary} />}
            label="View source"
            onPress={onViewSource}
          />
        )}
        {canExport && (
          <MoreMenuItem
            icon={<Download size={18} color={c.textSecondary} />}
            label="Export email (.eml)"
            onPress={onExport}
          />
        )}
      </Animated.View>
    </Modal>
  );
}

interface TagMenuSheetProps {
  visible: boolean;
  onClose: () => void;
  keywords: KeywordDef[];
  activeKeywords: Record<string, boolean>;
  onToggle: (token: string) => void;
}

function TagMenuSheet({ visible, onClose, keywords, activeKeywords, onToggle }: TagMenuSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const slideY = React.useRef(new Animated.Value(500)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({ slideY, closedY: 500, onClose });

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 500, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, overlayOpacity]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.sheetOverlay, { opacity: overlayOpacity }]}>
        <Pressable style={styles.sheetOverlayPress} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom, spacing.md), transform: [{ translateY: slideY }] },
        ]}
      >
        <View {...dragHandlers}>
          <View style={styles.sheetHandleHit}>
            <View style={styles.sheetHandle} />
          </View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Tags</Text>
            <Pressable onPress={onClose} hitSlop={8} style={styles.sheetClose}>
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
        {keywords.length === 0 ? (
          <Text style={{ ...typography.body, color: c.textMuted, paddingVertical: spacing.lg, paddingHorizontal: spacing.lg }}>
            No tags yet. Add some in Settings → Keywords & Labels.
          </Text>
        ) : (
          keywords.map((kw) => {
            const token = keywordToken(kw.id);
            const active = !!activeKeywords[token];
            const palette = c.tags[kw.color];
            return (
              <MoreMenuItem
                key={kw.id}
                icon={<View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: palette.dot }} />}
                label={kw.label}
                onPress={() => onToggle(token)}
                trailing={active ? <Check size={16} color={c.primary} /> : null}
              />
            );
          })
        )}
      </Animated.View>
    </Modal>
  );
}

function MoreMenuItem({
  icon, label, onPress, trailing,
}: { icon: React.ReactNode; label: string; onPress?: () => void; trailing?: React.ReactNode }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.moreItem, pressed && styles.moreItemPressed]}
    >
      <View style={styles.moreItemIcon}>{icon}</View>
      <Text style={styles.moreItemLabel}>{label}</Text>
      {trailing}
    </Pressable>
  );
}

function ToolbarButton({
  icon, label, onPress,
}: { icon: React.ReactNode; label: string; onPress?: () => void }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const showLabels = useSettingsStore((s) => s.showToolbarLabels);
  return (
    <Pressable
      onPress={onPress}
      style={styles.toolbarAction}
      hitSlop={6}
      accessibilityLabel={label}
    >
      {icon}
      {showLabels && <Text style={styles.toolbarActionLabel}>{label}</Text>}
    </Pressable>
  );
}

function BottomBarButton({
  icon, label, onPress, disabled,
}: { icon: React.ReactNode; label: string; onPress?: () => void; disabled?: boolean }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const showLabels = useSettingsStore((s) => s.showToolbarLabels);
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={[styles.bottomBarBtn, disabled && styles.bottomBarBtnDisabled]}
      hitSlop={4}
      accessibilityLabel={label}
    >
      {icon}
      {showLabels && (
        <Text style={[styles.bottomBarLabel, disabled && styles.bottomBarLabelDisabled]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },

  // Top toolbar
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
    backgroundColor: c.background,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  toolbarBack: {
    width: componentSizes.avatarSm,
    height: componentSizes.avatarSm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  toolbarActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  toolbarAction: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    minHeight: 44,
  },
  toolbarActionLabel: {
    ...typography.small,
    color: c.textSecondary,
  },

  // Content
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  errorText: { ...typography.body, color: c.error, textAlign: 'center' },
  // Pager: the horizontal page-snapping list fills the area between the bars.
  pagerViewport: { flex: 1, backgroundColor: c.background },
  scroll: { flex: 1, backgroundColor: c.background },

  // Subject block
  subjectBlock: {
    backgroundColor: c.background,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  subjectRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  subjectMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  subjectStar: {
    paddingTop: 4,
  },
  subjectText: {
    flex: 1,
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 28,
    color: c.text,
    letterSpacing: -0.2,
  },
  subjectMeta: {
    alignItems: 'flex-end',
  },
  subjectDate: {
    ...typography.caption,
    color: c.textSecondary,
  },
  subjectSize: {
    ...typography.caption,
    color: c.textMuted,
    marginTop: 2,
  },

  // Sender block
  senderBlock: {
    backgroundColor: c.background,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  senderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  senderInfo: { flex: 1, minWidth: 0 },
  senderName: {
    ...typography.bodySemibold,
    color: c.text,
  },
  senderEmail: {
    ...typography.caption,
    color: c.textSecondary,
    marginTop: 2,
  },
  senderRecipients: {
    ...typography.caption,
    color: c.textSecondary,
    marginTop: 4,
  },
  senderRecipientsLabel: {
    color: c.textMuted,
  },

  // Attachments
  attachmentsBlock: {
    backgroundColor: c.background,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  attachmentsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
  },
  attachmentChipPressed: {
    backgroundColor: c.surfaceHover,
    opacity: 0.85,
  },
  attachmentName: {
    ...typography.caption,
    color: c.text,
    maxWidth: 180,
  },
  attachmentSize: {
    ...typography.small,
    color: c.textMuted,
  },
  attachmentsToggle: {
    marginTop: spacing.xs,
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: spacing.xs,
  },
  attachmentsTogglePressed: {
    opacity: 0.6,
  },
  attachmentsToggleText: {
    ...typography.caption,
    color: c.primary,
    fontWeight: '600',
  },

  // Body
  bodyBlock: {
    backgroundColor: c.background,
  },

  // Loading skeleton
  skeletonBone: {
    backgroundColor: c.surfaceHover,
    borderRadius: radius.xs,
  },
  skeletonAvatar: {
    width: componentSizes.avatarMd,
    height: componentSizes.avatarMd,
    borderRadius: radius.full,
    backgroundColor: c.surfaceHover,
  },
  skeletonBody: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    gap: spacing.sm,
  },

  // Bottom bar
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: c.background,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  bottomBarBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    gap: 4,
    minHeight: 44,
  },
  bottomBarBtnDisabled: {
    opacity: 0.4,
  },
  bottomBarLabel: {
    ...typography.small,
    color: c.textSecondary,
  },
  bottomBarLabelDisabled: {
    color: c.textMuted,
  },

  // Bottom sheet (More menu / Move folder picker)
  sheetOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheetOverlayPress: { flex: 1 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: c.popover,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    borderColor: c.border,
    paddingTop: spacing.sm,
  },
  sheetHandleHit: {
    alignItems: 'center',
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.border,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  sheetTitle: {
    ...typography.bodySemibold,
    color: c.text,
  },
  sheetClose: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xs,
  },

  // More menu item
  moreItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 48,
  },
  moreItemPressed: { backgroundColor: c.surfaceHover },
  moreItemIcon: {
    width: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreItemLabel: {
    ...typography.body,
    color: c.text,
    flex: 1,
  },

  });
}
