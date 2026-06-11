import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator,
  Modal, useWindowDimensions, Animated, Easing, Alert, PanResponder,
} from 'react-native';
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

  const [loading, setLoading] = React.useState(true);
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

  // --- Swipe / slide navigation between adjacent emails -------------------
  // A three-pane pager: [prev | current | next] are laid out in a single row of
  // width 3×screen and kept mounted side by side. `drag` translates the whole
  // row so the neighbour's real content follows the finger — no blank gap and
  // no late content-swap. At rest the row is shifted left by one screen so the
  // middle (current) pane sits on screen. After a settled swipe we re-point
  // `activeEmailId` at the neighbour and reset `drag` to 0 in the same commit;
  // because the landed pane already shows that exact message, the recentre is
  // seamless. Refs keep the (memoised once) PanResponder reading the latest
  // neighbours / dimensions without being recreated every render.
  const drag = React.useRef(new Animated.Value(0)).current;
  const animatingRef = React.useRef(false);
  const prevEmailRef = React.useRef(prevEmail);
  const nextEmailRef = React.useRef(nextEmail);
  const windowWidthRef = React.useRef(windowWidth);
  prevEmailRef.current = prevEmail;
  nextEmailRef.current = nextEmail;
  windowWidthRef.current = windowWidth;

  const switchEmail = React.useCallback((direction: 'prev' | 'next') => {
    const target = direction === 'next' ? nextEmailRef.current : prevEmailRef.current;
    if (!target || animatingRef.current) return;
    animatingRef.current = true;
    const w = windowWidthRef.current;
    // Bring the neighbour pane to centre: next sits to the right (slide row
    // left → -w), prev sits to the left (slide row right → +w).
    const out = direction === 'next' ? -w : w;

    // Best-effort: ensure the target detail is cached so the recentred pane has
    // content. Neighbours are normally prefetched, so this is usually a no-op.
    if (!detailCache.has(target.id)) {
      getEmailDetail(target.id, jmapAccountId)
        .then((e) => { detailCache.set(target.id, e); bumpCache(); })
        .catch(() => { /* the load effect will retry once it becomes active */ });
    }

    Animated.timing(drag, {
      toValue: out, duration: 230, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) { animatingRef.current = false; return; }
      // Re-point at the neighbour and recentre in one go. The pane that just
      // slid to centre keeps its mounted WebView (it becomes the new middle
      // pane, keyed by id), so there is nothing to reload or flash.
      setActiveEmailId(target.id);
      drag.setValue(0);
      animatingRef.current = false;
    });
  }, [drag, detailCache, getEmailDetail, jmapAccountId, bumpCache]);
  const switchEmailRef = React.useRef(switchEmail);
  switchEmailRef.current = switchEmail;

  const panResponder = React.useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => {
        if (animatingRef.current) return false;
        if (Math.abs(g.dx) < 10) return false;
        // Only claim clearly-horizontal drags so the body's vertical scroll
        // (and link taps) keep working.
        return Math.abs(g.dx) > Math.abs(g.dy) * 1.5;
      },
      onPanResponderMove: (_, g) => {
        let dx = g.dx;
        // Rubber-band when there's no neighbour to reach in that direction.
        if ((dx > 0 && !prevEmailRef.current) || (dx < 0 && !nextEmailRef.current)) {
          dx *= 0.25;
        }
        drag.setValue(dx);
      },
      onPanResponderRelease: (_, g) => {
        const w = windowWidthRef.current;
        const threshold = Math.min(w * 0.28, 120);
        const fast = Math.abs(g.vx) > 0.5;
        if ((g.dx <= -threshold || (fast && g.vx < 0)) && nextEmailRef.current) {
          switchEmailRef.current('next');
        } else if ((g.dx >= threshold || (fast && g.vx > 0)) && prevEmailRef.current) {
          switchEmailRef.current('prev');
        } else {
          Animated.spring(drag, { toValue: 0, useNativeDriver: true, speed: 20, bounciness: 6 }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(drag, { toValue: 0, useNativeDriver: true, speed: 20, bounciness: 6 }).start();
      },
      onPanResponderTerminationRequest: () => true,
    }),
  ).current;

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
    // If we already have this message cached (e.g. it was prefetched as a
    // neighbour), show it immediately — no spinner — and refresh in the
    // background. Otherwise fall back to the loading state.
    const cached = detailCache.get(activeEmailId);
    if (cached) {
      setLoading(false);
      setError(null);
    } else {
      setLoading(true);
      setError(null);
    }
    void (async () => {
      try {
        const fetched = await getEmailDetail(activeEmailId, jmapAccountId);
        if (cancelled) return;
        detailCache.set(activeEmailId, fetched);
        bumpCache();
        if (fetched && !fetched.keywords?.$seen) {
          if (markAsReadDelay > 0) {
            readTimer = setTimeout(() => {
              if (!cancelled) void markRead(activeEmailId, jmapAccountId);
            }, markAsReadDelay);
          } else {
            void markRead(activeEmailId, jmapAccountId);
          }
        }
      } catch (e) {
        // Only surface the error if we have nothing to show; a cached copy is
        // better than an error screen when the refresh fails.
        if (!cancelled && !detailCache.has(activeEmailId)) {
          setError(e instanceof Error ? e.message : 'Failed to load email');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (readTimer) clearTimeout(readTimer);
    };
  }, [activeEmailId, jmapAccountId, getEmailDetail, markRead, markAsReadDelay, detailCache, bumpCache]);

  // Prefetch the adjacent messages so their pane is already populated when the
  // pager slides it into view. Best-effort and silent; bump the cache version
  // on arrival so the off-screen neighbour pane renders its content.
  React.useEffect(() => {
    for (const neighbour of [prevEmail, nextEmail]) {
      if (neighbour && !detailCache.has(neighbour.id)) {
        getEmailDetail(neighbour.id, jmapAccountId)
          .then((e) => { detailCache.set(neighbour.id, e); bumpCache(); })
          .catch(() => { /* ignore — prefetch is best-effort */ });
      }
    }
  }, [prevEmail, nextEmail, getEmailDetail, jmapAccountId, detailCache, bumpCache]);

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

      {loading && !email ? (
        <View style={styles.centered}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : error && !email ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : email ? (
        <>
          {/* Three-pane pager: [prev | current | next] live side by side in a
              row shifted left by one screen, so a horizontal drag slides the
              neighbour's already-rendered content into view with no gap. */}
          <View style={styles.pagerViewport}>
            <Animated.View
              style={[
                styles.pagerRow,
                { width: windowWidth * 3, left: -windowWidth, transform: [{ translateX: drag }] },
              ]}
              {...panResponder.panHandlers}
            >
              {[prevEmail?.id ?? null, activeEmailId, nextEmail?.id ?? null].map((id, i) => (
                <View key={id ?? `empty-${i}`} style={{ width: windowWidth }}>
                  {id ? (
                    <EmailPane
                      email={detailCache.get(id) ?? null}
                      c={c}
                      styles={styles}
                      bottomBarHeight={bottomBarHeight}
                      attachmentPosition={attachmentPosition}
                      hideInlineImageAttachments={hideInlineImageAttachments}
                      downloadingBlobId={downloadingBlobId}
                      onToggleStar={toggleStarFor}
                      onPressAttachment={onPressAttachment}
                    />
                  ) : null}
                </View>
              ))}
            </Animated.View>
          </View>

          {/* Bottom action bar */}
          <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 4) }]}>
            <BottomBarButton
              icon={<ChevronLeft size={20} color={c.textMuted} />}
              label="Prev"
              onPress={prevEmail ? () => switchEmail('prev') : undefined}
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
              onPress={nextEmail ? () => switchEmail('next') : undefined}
              disabled={!nextEmail}
            />
          </View>
        </>
      ) : null}

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
  email: Email | null;
  c: ThemePalette;
  styles: ReturnType<typeof makeStyles>;
  bottomBarHeight: number;
  attachmentPosition: 'beside-sender' | 'below-header';
  hideInlineImageAttachments: boolean;
  downloadingBlobId: string | null;
  onToggleStar: (email: Email) => void;
  onPressAttachment: (email: Email, blobId: string, name: string | undefined, type: string | undefined) => void;
}

// One swipeable page: the scrollable subject / sender / attachments / body for a
// single message. The pager keeps three of these mounted (prev, current, next)
// so a swipe slides ready content into view. Each pane owns its own vertical
// scroll position and "show all attachments" toggle, and renders directly from
// the email passed to it — neighbours show real content, not a placeholder.
function EmailPane({
  email, c, styles, bottomBarHeight, attachmentPosition,
  hideInlineImageAttachments, downloadingBlobId, onToggleStar, onPressAttachment,
}: EmailPaneProps) {
  const [attachmentsExpanded, setAttachmentsExpanded] = React.useState(false);

  // A neighbour whose detail hasn't been prefetched yet. Brief and uncommon
  // (the prefetch effect usually beats the swipe), so a spinner is fine.
  if (!email) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={c.primary} />
      </View>
    );
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
        <EmailBodyView email={email} senderEmail={from?.email} />
      </View>
    </ScrollView>
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
  // Pager: a clipping viewport with a 3-screen-wide row of panes inside it.
  pagerViewport: { flex: 1, overflow: 'hidden', backgroundColor: c.background },
  pagerRow: { position: 'absolute', top: 0, bottom: 0, flexDirection: 'row' },
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
