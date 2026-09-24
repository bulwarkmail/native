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
  ChevronLeft, ChevronRight, Archive, Mail, MailOpen,
  FolderInput, ShieldAlert, ShieldCheck, X, Check,
  Code, Download, Tag, Sun, Moon, FileInput, UserRoundPlus,
} from 'lucide-react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors, useResolvedTheme } from '../theme/colors';
import { MoveSheet } from '../components/MoveSheet';
import { ThreadMessageCard, ThreadCardPlaceholder } from '../components/email/ThreadMessageCard';
import { QuickReplyBox } from '../components/email/QuickReplyBox';
import { AddressActionSheet } from '../components/email/AddressActionSheet';
import { ToastHost } from '../components/ToastHost';
import { useEmailStore } from '../stores/email-store';
import { toast } from '../stores/toast-store';
import {
  useSettingsStore,
  normalizeBottomQuickActions,
  REPLY_QUICK_ACTIONS,
  type QuickAction,
} from '../stores/settings-store';
import { patchKeywordsForEmails } from '../api/email';
import {
  loadDetail, loadDetails, loadThread, patchDetail, peekDetail, peekRow, peekThread, subscribeEmailCache,
  type FlagsHint,
} from '../lib/email-detail-cache';
import { shareEmailEml } from '../lib/email-export';
import { useKeywordsStore, keywordToken, type KeywordDef } from '../stores/keywords-store';
import { useSheetDrag } from '../lib/use-sheet-drag';
import { useLocaleStore } from '../stores/locale-store';
import {
  findArchiveMailbox, findTrashMailbox, mailboxAccountId, mailboxesOfAccount, mailboxOfEmail,
} from '../lib/mailbox-tree';
import { pickEmailBody, plainTextBody } from '../lib/email-body';
import { singleLine } from '../lib/single-line';
import { buildForwardAsAttachmentPayload } from '../lib/forward-as-attachment';
import { viewerInstance, viewerPages, type ViewerInstance } from '../lib/viewer-pages';
import type { Email, EmailAddress, Identity } from '../api/types';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'EmailThread'>;

// How long the pages beside the one on screen wait for its body at most.
const NEIGHBOUR_FALLBACK_MS = 1500;

// Actions finish after the viewer may already have gone back, so a failure is
// reported as a toast instead of vanishing with the promise (webmail
// `lib/email-action-toast.ts`).
function toastFailure(title: string, err: unknown): void {
  console.warn('[viewer]', title, err);
  toast.error(title, err instanceof Error ? err.message : undefined);
}

/**
 * The viewer route. A new target handed to it while it is showing (a
 * notification tapped with the viewer open) arrives as new params on the same
 * route; the viewer is mounted afresh for it, taking its own page snapshot,
 * instead of ignoring it.
 */
export default function EmailThreadScreen(props: Props) {
  const instance = React.useRef<ViewerInstance | null>(null);
  instance.current = viewerInstance(instance.current, props.route.params);
  return <EmailViewer key={instance.current.key} {...props} />;
}

function EmailViewer({ route, navigation }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { t } = useLocaleStore();
  // The JMAP account the message lives in, as the screen that opened it named
  // it (undefined = the user's own). Never the open folder's: that may be
  // another account holding a different message under the same id (B3).
  // Fixed for this instance: a new target mounts a new one.
  const [ownerAccountId] = React.useState(route.params.jmapAccountId);
  // The displayed email is tracked in local state (not a route param) so that
  // swiping / Prev-Next can switch messages in place without remounting the
  // screen — which is what produced the loading flash on every change.
  const [activeEmailId, setActiveEmailId] = React.useState(route.params.emailId);
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const markRead = useEmailStore((s) => s.markRead);
  const setKeywordForEmails = useEmailStore((s) => s.setKeywordForEmails);
  const deleteEmail = useEmailStore((s) => s.deleteEmail);
  const moveToMailbox = useEmailStore((s) => s.moveToMailbox);
  const archiveEmailAction = useEmailStore((s) => s.archiveEmail);
  const markSpam = useEmailStore((s) => s.markSpam);
  const unmarkSpam = useEmailStore((s) => s.unmarkSpam);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const currentMailboxId = useEmailStore((s) => s.currentMailboxId);
  const disableThreading = useSettingsStore((s) => s.disableThreading);
  const identities = useSettingsStore((s) => s.identities);
  const ensureIdentities = useSettingsStore((s) => s.ensureIdentities);
  const deleteAction = useSettingsStore((s) => s.deleteAction);
  const permanentlyDeleteJunk = useSettingsStore((s) => s.permanentlyDeleteJunk);
  const postExportAction = useSettingsStore((s) => s.postExportAction);
  const emailAlwaysLightMode = useSettingsStore((s) => s.emailAlwaysLightMode);
  const exportSpaceReplacement = useSettingsStore((s) => s.exportSpaceReplacement);
  const exportLowercase = useSettingsStore((s) => s.exportLowercase);
  const exportStripDiacritics = useSettingsStore((s) => s.exportStripDiacritics);
  const resolvedTheme = useResolvedTheme();
  // Held for the account after the first read, even when it has none.
  React.useEffect(() => { void ensureIdentities(); }, [ensureIdentities]);

  // The account whose mail the store's list holds (the open folder's). Its
  // rows only stand for this message when that is the message's account.
  const listAccountId = React.useMemo(
    () => mailboxAccountId(mailboxes, currentMailboxId),
    [mailboxes, currentMailboxId],
  );

  // The pages the pager swipes through (see viewerPages), taken once when the
  // viewer opens: new mail or a refresh must not shift the page under the
  // user while the toolbar acts on `activeEmailId` (B5). Delete, archive,
  // move and spam leave the screen, so no page outlives its message here.
  // A page handed over by id takes the row its list left in the cache (the
  // Unified Inbox's, a tapped one), so its header can be painted too.
  const [emails] = React.useState<Email[]>(() => viewerPages({
    emailId: route.params.emailId,
    threadId: route.params.threadId,
    emailIds: route.params.emailIds,
    list: useEmailStore.getState().emails,
    listIsMessageAccount: listAccountId === ownerAccountId,
    threading: !disableThreading,
  }).map((page) => (page.receivedAt ? page : peekRow(page.id, ownerAccountId) ?? page)));

  const currentMailboxRole = React.useMemo(
    () => (currentMailboxId ? mailboxes.find((m) => m.id === currentMailboxId)?.role ?? null : null),
    [mailboxes, currentMailboxId],
  );

  const currentIndex = emails.findIndex((e) => e.id === activeEmailId);
  const prevEmail = currentIndex > 0 ? emails[currentIndex - 1] : null;
  const nextEmail = currentIndex >= 0 && currentIndex < emails.length - 1 ? emails[currentIndex + 1] : null;
  const prevId = prevEmail?.id;
  const nextId = nextEmail?.id;

  const [error, setError] = React.useState<string | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = React.useState(false);
  const [moveMenuOpen, setMoveMenuOpen] = React.useState(false);
  const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
  const [addressSheet, setAddressSheet] = React.useState<EmailAddress | null>(null);
  // Per-message override of the light/dark rendering (More sheet toggle).
  const [themeOverrides, setThemeOverrides] = React.useState<Record<string, 'light' | 'dark'>>({});

  // Message details and conversations come from the shared cache
  // (lib/email-detail-cache): every rendered pane, the active one and its
  // neighbours, reads from it, so a swipe lands on ready content and a message
  // opened before paints at once. `cacheVersion` is bumped on every change to
  // it so the panes re-render.
  const [cacheVersion, setCacheVersion] = React.useState(0);
  const bumpCache = React.useCallback(() => setCacheVersion((v) => v + 1), []);
  React.useEffect(() => subscribeEmailCache(bumpCache), [bumpCache]);
  const detailOf = React.useCallback(
    (id: string) => peekDetail(id, ownerAccountId),
    [ownerAccountId],
  );
  const email = React.useMemo(
    () => detailOf(activeEmailId) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeEmailId, cacheVersion, detailOf],
  );
  // Conversations whose fetch failed with nothing held: shown as one message.
  const failedThreads = React.useRef(new Set<string>()).current;

  // --- Pager -------------------------------------------------------------
  // A horizontal, page-snapping FlatList over `emails`. Native scroll provides
  // the swipe + snap; Prev/Next scroll programmatically. When scrolling
  // settles, the centred page's id becomes `activeEmailId`, which is what the
  // toolbar and action handlers operate on.
  const listRef = React.useRef<FlatList<Email>>(null);
  const initialIndexRef = React.useRef(
    Math.max(0, emails.findIndex((e) => e.id === route.params.emailId)),
  );

  // What each page's list row said about its message the first time it is
  // loaded here: a copy held from an earlier open that disagrees with it (the
  // user marked it unread in the list a moment ago) is checked first. Later
  // loads go by the cache, which has the viewer's own changes.
  const hintedIds = React.useRef(new Set<string>()).current;
  const hintFor = React.useCallback((id: string): FlagsHint | undefined => {
    if (hintedIds.has(id)) return undefined;
    hintedIds.add(id);
    const row = emails.find((e) => e.id === id);
    return row?.keywords ? { keywords: row.keywords, mailboxIds: row.mailboxIds } : undefined;
  }, [emails, hintedIds]);

  // Cache first: a held copy renders at once and the promise resolves with the
  // checked one (which mark-as-read goes by). Concurrent loads share a request.
  const ensureDetail = React.useCallback(
    (id: string): Promise<Email | null> =>
      loadDetail(id, ownerAccountId, hintFor(id)).catch(() => peekDetail(id, ownerAccountId) ?? null),
    [ownerAccountId, hintFor],
  );
  const ensureDetails = React.useCallback((ids: string[]) => {
    const missing = ids.filter((id) => !peekDetail(id, ownerAccountId));
    if (missing.length > 0) void loadDetails(missing, ownerAccountId);
  }, [ownerAccountId]);

  // The conversation's members without bodies; the cards fetch bodies only
  // when opened (ensureDetails).
  const ensureThread = React.useCallback((threadId: string): void => {
    void loadThread(threadId, ownerAccountId).catch((err) => {
      console.warn('[thread] fetch failed', err);
      // Show the single message instead of a spinner that never ends.
      failedThreads.add(threadId);
      bumpCache();
    });
  }, [ownerAccountId, failedThreads, bumpCache]);
  const threadIdsOf = React.useCallback((threadId: string): string[] | null => {
    const view = peekThread(threadId, ownerAccountId);
    if (view) return view.ids;
    return failedThreads.has(threadId) ? [] : null;
  }, [ownerAccountId, failedThreads]);
  // The conversation's size as the open folder's list knows it (only when
  // that list is the message's account: thread ids are per account).
  const threadSizeOf = React.useCallback(
    (threadId: string): number | undefined => (listAccountId === ownerAccountId
      ? useEmailStore.getState().threadCounts[threadId]
      : undefined),
    [listAccountId, ownerAccountId],
  );
  const memberOf = React.useCallback(
    (threadId: string, id: string): Email | undefined =>
      peekDetail(id, ownerAccountId) ?? peekThread(threadId, ownerAccountId)?.headers.get(id),
    [ownerAccountId],
  );

  // The pages beside the one on screen wait for it: their fetches and
  // WebViews would otherwise compete with it for the network, the JS thread
  // and the WebView process while it opens. They are let go once its body has
  // reported its height, as soon as the user starts to swipe, or after a
  // while regardless; until then they show their header and placeholders.
  const [neighboursReady, setNeighboursReady] = React.useState(false);
  const releaseNeighbours = React.useCallback(() => setNeighboursReady(true), []);
  React.useEffect(() => {
    if (neighboursReady) return;
    const timer = setTimeout(releaseNeighbours, NEIGHBOUR_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [neighboursReady, releaseNeighbours]);

  // Both neighbours in one request once they may load (see neighboursReady).
  React.useEffect(() => {
    if (!neighboursReady) return;
    const ids = [prevId, nextId].filter((id): id is string => !!id && !peekDetail(id, ownerAccountId));
    if (ids.length === 0) return;
    void loadDetails(ids, ownerAccountId, Object.fromEntries(ids.map((id) => [id, hintFor(id)])));
  }, [neighboursReady, prevId, nextId, ownerAccountId, hintFor]);

  const goToIndex = React.useCallback((index: number) => {
    if (index < 0 || index >= emails.length) return;
    releaseNeighbours();
    listRef.current?.scrollToOffset({ offset: index * windowWidth, animated: true });
    const target = emails[index];
    if (target) setActiveEmailId(target.id);
  }, [emails, windowWidth, releaseNeighbours]);

  const onMomentumEnd = React.useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / windowWidth);
    const target = emails[index];
    if (target && target.id !== activeEmailId) setActiveEmailId(target.id);
  }, [emails, windowWidth, activeEmailId]);

  React.useLayoutEffect(() => {
    const index = emails.findIndex((e) => e.id === activeEmailId);
    if (index >= 0) listRef.current?.scrollToOffset({ offset: index * windowWidth, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowWidth]);

  const pagerExtraData = React.useMemo(
    () => [cacheVersion, neighboursReady],
    [cacheVersion, neighboursReady],
  );

  // While the body is pinch-zoomed the pager must not treat horizontal
  // gestures as page swipes.
  const [pagerLocked, setPagerLocked] = React.useState(false);
  React.useEffect(() => { setPagerLocked(false); }, [activeEmailId]);

  const markAsReadDelay = useSettingsStore((s) => s.markAsReadDelay);
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

  const keywordDefs = useKeywordsStore((s) => s.keywords);
  const hydrateKeywords = useKeywordsStore((s) => s.hydrate);
  const keywordsHydrated = useKeywordsStore((s) => s.hydrated);
  React.useEffect(() => { if (!keywordsHydrated) void hydrateKeywords(); }, [keywordsHydrated, hydrateKeywords]);

  // Optimistically write a message's keywords into the cache (the single source
  // of truth for every pane, and for the next open); its listeners re-render.
  const updateLocalKeywords = React.useCallback((id: string, next: Record<string, boolean>) => {
    patchDetail(id, ownerAccountId, { keywords: next });
  }, [ownerAccountId]);

  // Mark read through the store (its list row and offline queue) only when
  // the list holds the message's account; the store would otherwise read the
  // id as a row of the open folder's account (B3), so go to the server.
  const markSeen = React.useCallback(
    (id: string) => (listAccountId === ownerAccountId
      ? markRead(id, ownerAccountId)
      : patchKeywordsForEmails([id], { $seen: true }, ownerAccountId)),
    [listAccountId, ownerAccountId, markRead],
  );

  // Star, tag and unread go through the store as well, which knows the
  // message's account from `viewed`: offline they wait in the outbox, and the
  // list row follows when the list holds that account (never a same-id row
  // of another one).
  const setKeyword = React.useCallback(
    (target: Email, token: string, on: boolean) =>
      setKeywordForEmails([target.id], token, on, { email: target, accountId: ownerAccountId }),
    [setKeywordForEmails, ownerAccountId],
  );

  // Mark a message read per the user's delay setting: -1 never, 0 instantly,
  // >0 after that many milliseconds. Returns a cancel function.
  const scheduleMarkRead = React.useCallback((target: Email): (() => void) => {
    if (target.keywords?.$seen || markAsReadDelay === -1) return () => undefined;
    const apply = () => {
      updateLocalKeywords(target.id, { ...target.keywords, $seen: true });
      void markSeen(target.id);
    };
    if (markAsReadDelay > 0) {
      const timer = setTimeout(apply, markAsReadDelay);
      return () => clearTimeout(timer);
    }
    apply();
    return () => undefined;
  }, [markAsReadDelay, markSeen, updateLocalKeywords]);

  React.useEffect(() => {
    let cancelled = false;
    let cancelRead: (() => void) | null = null;
    // Refresh the active message — a cached copy renders immediately while
    // this lands. Then mark it read per the user's delay.
    setError(null);
    void (async () => {
      const fetched = await ensureDetail(activeEmailId);
      if (cancelled) return;
      if (!fetched) {
        if (!detailOf(activeEmailId)) setError(t('email_viewer.load_failed', 'Failed to load email'));
        return;
      }
      cancelRead = scheduleMarkRead(fetched);
    })();
    return () => {
      cancelled = true;
      cancelRead?.();
    };
  }, [activeEmailId, ensureDetail, scheduleMarkRead, detailOf, t]);

  const starred = !!email?.keywords?.$flagged;
  const unread = !!email && !email.keywords?.$seen;

  // Move/archive/spam/trash targets have to live in the message's own account,
  // whatever folder is open (B3). None are found while that account's folders
  // are unknown, and the actions then refuse rather than guess.
  const scopedMailboxes = React.useMemo(
    () => mailboxesOfAccount(mailboxes, ownerAccountId),
    [mailboxes, ownerAccountId],
  );
  // The store's rule (role, else a folder named exactly "Archive"), so the
  // button is offered exactly when the archive action can file the message.
  const archiveMailbox = React.useMemo(
    () => findArchiveMailbox(scopedMailboxes),
    [scopedMailboxes],
  );
  const junkMailbox = React.useMemo(
    () => scopedMailboxes.find((m) => m.role === 'junk' || m.role === 'spam'),
    [scopedMailboxes],
  );
  const inboxMailbox = React.useMemo(
    () => scopedMailboxes.find((m) => m.role === 'inbox'),
    [scopedMailboxes],
  );
  // `mailboxIds` comes back from the server unprefixed, so compare on the
  // folder's raw id rather than the sidebar key.
  const isInJunk = !!(junkMailbox && email?.mailboxIds?.[junkMailbox.originalId ?? junkMailbox.id]);
  const trashMailbox = React.useMemo(() => findTrashMailbox(scopedMailboxes), [scopedMailboxes]);
  // The folder the message is filed in (the one it was opened from, when
  // that is one of its own): what delete and move take it out of.
  const sourceMailbox = React.useMemo(
    () => mailboxOfEmail(scopedMailboxes, email?.mailboxIds, currentMailboxId),
    [scopedMailboxes, email, currentMailboxId],
  );
  const isInTrash = !!(trashMailbox && sourceMailbox?.id === trashMailbox.id);
  const canArchive = !!archiveMailbox && sourceMailbox?.id !== archiveMailbox.id;
  // Not spam files back into the Inbox, so it needs one.
  const canToggleSpam = isInJunk ? !!inboxMailbox : !!junkMailbox;

  const onToggleKeyword = (token: string) => {
    if (!email) return;
    const next = { ...email.keywords };
    if (next[token]) delete next[token];
    else next[token] = true;
    updateLocalKeywords(email.id, next);
    setKeyword(email, token, !!next[token]).catch((err) => {
      updateLocalKeywords(email.id, email.keywords);
      toastFailure(t('notifications.tag_failed', 'Tagging failed'), err);
    });
  };

  // Toggle the star on a specific message — used both by the toolbar (current
  // message) and by each pane's own subject star / card header.
  const toggleStarFor = React.useCallback((target: Email) => {
    const next = { ...target.keywords };
    if (next.$flagged) delete next.$flagged;
    else next.$flagged = true;
    updateLocalKeywords(target.id, next);
    setKeyword(target, '$flagged', !!next.$flagged).catch((err) => {
      updateLocalKeywords(target.id, target.keywords);
      toastFailure(t('notifications.error_updating', 'Failed to update email'), err);
    });
  }, [updateLocalKeywords, setKeyword, t]);

  const onToggleStar = () => { if (email) toggleStarFor(email); };

  const onToggleUnread = () => {
    if (!email) return;
    const failed = (err: unknown) => {
      updateLocalKeywords(email.id, email.keywords);
      toastFailure(t('notifications.error_updating', 'Failed to update email'), err);
    };
    if (unread) {
      markSeen(email.id).catch(failed);
      updateLocalKeywords(email.id, { ...email.keywords, $seen: true });
    } else {
      const next = { ...email.keywords };
      delete next.$seen;
      updateLocalKeywords(email.id, next);
      setKeyword(email, '$seen', false).catch(failed);
    }
  };

  // Banners and the quick reply hand back the message with a keyword changed
  // (`$mdnsent`, `$answered`); only that goes into the cache.
  const onEmailPatched = React.useCallback((patched: Email) => {
    patchDetail(patched.id, ownerAccountId, { keywords: patched.keywords });
  }, [ownerAccountId]);

  const performDelete = () => {
    if (!email || !sourceMailbox || !trashMailbox) return;
    deleteEmail(email.id, trashMailbox.id, sourceMailbox.id, { email, accountId: ownerAccountId })
      .catch((err) => toastFailure(t('notifications.error_deleting', 'Failed to delete email'), err));
    navigation.goBack();
  };

  const onDelete = () => {
    if (!email) return;
    if (!trashMailbox || !sourceMailbox) {
      Alert.alert(
        t('email_list.error', 'Error'),
        t('email_list.no_trash_folder', 'Could not find a Trash folder on the server. Please check your mailbox configuration.'),
      );
      return;
    }
    // The store destroys (instead of moving) in trash, for junk when the user
    // opted to skip the trash, and when the delete action is "permanent" -
    // none of those can be undone, so confirm first.
    const permanent = isInTrash || deleteAction === 'permanent' || (permanentlyDeleteJunk && isInJunk);
    if (permanent) {
      Alert.alert(
        t('email_viewer.delete_permanently_title', 'Delete permanently?'),
        t('email_viewer.delete_permanently_message', 'This message will be deleted permanently and cannot be recovered.'),
        [
          { text: t('common.cancel', 'Cancel'), style: 'cancel' },
          { text: t('common.delete', 'Delete'), style: 'destructive', onPress: performDelete },
        ],
      );
      return;
    }
    performDelete();
  };

  const onArchive = () => {
    if (!email || !canArchive) return;
    archiveEmailAction(email.id, { email, accountId: ownerAccountId })
      .catch((err) => toastFailure(t('notifications.error_archiving', 'Failed to archive email'), err));
    navigation.goBack();
  };

  // The same store path as the list and swipe actions: files into the
  // message's own Junk or Inbox, flips `$junk`/`$notjunk` and honours
  // trash-and-read (#695).
  const onToggleSpam = () => {
    if (!email || !canToggleSpam) return;
    setMoreMenuOpen(false);
    const viewed = { email, accountId: ownerAccountId };
    if (isInJunk) {
      unmarkSpam([email.id], viewed)
        .catch((err) => toastFailure(t('email_viewer.spam.error_not_spam', 'Failed to restore email'), err));
    } else {
      markSpam([email.id], viewed)
        .catch((err) => toastFailure(t('email_viewer.spam.error', 'Failed to report spam'), err));
    }
    navigation.goBack();
  };

  const onMoveToMailbox = (toId: string) => {
    if (!email || !sourceMailbox || toId === sourceMailbox.id) return;
    setMoveMenuOpen(false);
    setMoreMenuOpen(false);
    moveToMailbox(email.id, sourceMailbox.id, toId, { email, accountId: ownerAccountId })
      .catch((err) => toastFailure(t('notifications.move_failed', 'Move failed'), err));
    navigation.goBack();
  };

  // Reply / forward the given message (a thread card's own, or the active one).
  const navigateCompose = React.useCallback((mode: 'reply' | 'replyAll' | 'forward', target?: Email) => {
    const source = target ?? email;
    if (!source) return;
    const from = source.from?.[0];
    if (!from && mode !== 'forward') return;
    // Quote the HTML part when there is one so layout and inline images
    // survive (#163). RFC 8621 §4.1.4: an HTML-only message exposes the same
    // part in `textBody` and `htmlBody`, so the text part is only a real
    // alternative when its partId differs - otherwise the composer would be
    // handed raw HTML source (#649, native #46).
    const picked = pickEmailBody(source);
    const quoteHtml = picked.html ?? undefined;
    const body = !quoteHtml || picked.text ? plainTextBody(source) : undefined;
    navigation.navigate('Compose', {
      mode,
      replyTo: {
        from: from ?? { email: '' },
        to: source.to,
        cc: source.cc,
        // RFC 5322: a reply goes to Reply-To when the sender set one.
        replyToAddresses: source.replyTo,
        subject: source.subject ?? '',
        body,
        htmlBody: quoteHtml,
        receivedAt: source.receivedAt,
        sentAt: source.sentAt,
        // Threading needs the RFC Message-ID, never the JMAP object id (#234).
        messageId: source.messageId ?? undefined,
        references: source.references ?? undefined,
        // Forward carries the original attachments as blob refs; cid-embedded
        // inline images are already part of the quoted HTML.
        attachments: mode === 'forward'
          ? (source.attachments ?? []).filter((a) => !(a.disposition === 'inline' && a.cid))
          : undefined,
        originalEmailId: source.id,
        jmapAccountId: ownerAccountId,
      },
    });
  }, [email, navigation, ownerAccountId]);

  // Forward the raw message as a message/rfc822 attachment (webmail 1.8.1).
  const onForwardAsAttachment = () => {
    setMoreMenuOpen(false);
    if (!email) return;
    const payload = buildForwardAsAttachmentPayload(
      email,
      t('email_composer.prefix.forward', 'Fwd:'),
      { spaceReplacement: exportSpaceReplacement, lowercase: exportLowercase, stripDiacritics: exportStripDiacritics },
    );
    if (!payload) return;
    navigation.navigate('Compose', {
      mode: 'forward',
      replyTo: {
        from: email.from?.[0] ?? { email: '' },
        subject: email.subject ?? '',
        attachments: [payload.attachment],
        originalEmailId: email.id,
        jmapAccountId: ownerAccountId,
      },
    });
  };

  // Registry of every action that can live in the bottom quick-action bar (or
  // be relocated to the top toolbar).
  const quickActionRegistry: Record<
    QuickAction,
    { label: string; icon: (size: number, color: string) => React.ReactNode; onPress: () => void; available: boolean }
  > = {
    reply: {
      label: t('email_viewer.reply', 'Reply'),
      icon: (s, col) => <Reply size={s} color={col} />,
      onPress: () => navigateCompose('reply'),
      available: true,
    },
    replyAll: {
      label: t('email_viewer.reply_all', 'Reply All'),
      icon: (s, col) => <ReplyAll size={s} color={col} />,
      onPress: () => navigateCompose('replyAll'),
      available: true,
    },
    forward: {
      label: t('email_viewer.forward', 'Forward'),
      icon: (s, col) => <Forward size={s} color={col} />,
      onPress: () => navigateCompose('forward'),
      available: true,
    },
    delete: {
      label: t('email_viewer.delete', 'Delete'),
      icon: (s, col) => <Trash2 size={s} color={col} />,
      onPress: onDelete,
      available: true,
    },
    archive: {
      label: t('email_viewer.archive', 'Archive'),
      icon: (s, col) => <Archive size={s} color={col} />,
      onPress: onArchive,
      available: canArchive,
    },
    markUnread: {
      label: unread ? t('email_viewer.read', 'Read') : t('email_viewer.unread', 'Unread'),
      icon: (s, col) => (unread ? <MailOpen size={s} color={col} /> : <Mail size={s} color={col} />),
      onPress: onToggleUnread,
      available: true,
    },
    star: {
      label: starred ? t('email_viewer.unstar', 'Unstar') : t('email_viewer.star', 'Star'),
      icon: (s, col) => (
        <Star size={s} color={starred ? c.starred : col} fill={starred ? c.starred : 'transparent'} />
      ),
      onPress: onToggleStar,
      available: true,
    },
    move: {
      label: t('email_viewer.move', 'Move'),
      icon: (s, col) => <FolderInput size={s} color={col} />,
      onPress: () => setMoveMenuOpen(true),
      available: !!sourceMailbox,
    },
    spam: {
      label: isInJunk ? t('email_viewer.not_spam_short', 'Not spam') : t('email_viewer.spam_short', 'Spam'),
      icon: (s, col) =>
        isInJunk ? <ShieldCheck size={s} color={c.success} /> : <ShieldAlert size={s} color={col} />,
      onPress: onToggleSpam,
      available: canToggleSpam,
    },
    tag: {
      label: t('email_viewer.tag', 'Tag'),
      icon: (s, col) => <Tag size={s} color={col} />,
      onPress: () => setTagMenuOpen(true),
      available: keywordDefs.length > 0,
    },
  };

  const bottomBarHeight = 60 + Math.max(insets.bottom, 4);
  // Drop optional toolbar buttons on narrow screens.
  const showMarkUnread = windowWidth >= 340;
  const showArchive = windowWidth >= 400 && canArchive;

  // Current rendering mode of the active message, for the More sheet label.
  const activeRenderDark = email
    ? (themeOverrides[email.id] ? themeOverrides[email.id] === 'dark' : !emailAlwaysLightMode && resolvedTheme === 'dark')
    : false;

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
            label={t('email_viewer.delete', 'Delete')}
            onPress={onDelete}
          />
          {showArchive && (
            <ToolbarButton
              icon={<Archive size={18} color={c.textSecondary} />}
              label={t('email_viewer.archive', 'Archive')}
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
              label={unread ? t('email_viewer.read', 'Read') : t('email_viewer.unread', 'Unread')}
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
            label={t('email_viewer.star', 'Star')}
            onPress={onToggleStar}
          />
          <ToolbarButton
            icon={<MoreVertical size={18} color={c.textSecondary} />}
            label={t('email_viewer.more', 'More')}
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
          <FlatList
            ref={listRef}
            style={styles.pagerViewport}
            data={emails}
            extraData={pagerExtraData}
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
            scrollEnabled={!pagerLocked}
            onScrollBeginDrag={releaseNeighbours}
            onMomentumScrollEnd={onMomentumEnd}
            renderItem={({ item, index }) => (
              <View style={{ width: windowWidth }}>
                <EmailPane
                  id={item.id}
                  active={item.id === activeEmailId}
                  bodyEnabled={item.id === activeEmailId || neighboursReady}
                  onBodySettled={item.id === activeEmailId ? releaseNeighbours : undefined}
                  threadIdHint={item.threadId}
                  email={detailOf(item.id) ?? null}
                  row={item}
                  threadIds={
                    !disableThreading
                      ? threadIdsOf(detailOf(item.id)?.threadId ?? item.threadId)
                      : null
                  }
                  memberOf={memberOf}
                  threadSizeHint={!disableThreading ? threadSizeOf(item.threadId) : undefined}
                  threading={!disableThreading}
                  jmapAccountId={ownerAccountId}
                  currentMailboxRole={currentMailboxRole}
                  identities={identities}
                  themeOverrides={themeOverrides}
                  ensureDetail={ensureDetail}
                  ensureDetails={ensureDetails}
                  ensureThread={ensureThread}
                  scheduleMarkRead={scheduleMarkRead}
                  styles={styles}
                  bottomBarHeight={bottomBarHeight}
                  onToggleStar={toggleStarFor}
                  onAddressPress={setAddressSheet}
                  onEmailPatched={onEmailPatched}
                  onReply={navigateCompose}
                  onSwipe={(dir) => goToIndex(dir === 'next' ? index + 1 : index - 1)}
                  onZoomChange={(z) => setPagerLocked(z.pinching || z.zoomed)}
                />
              </View>
            )}
          />

          {/* Bottom action bar */}
          <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 4) }]}>
            <BottomBarButton
              icon={<ChevronLeft size={20} color={c.textMuted} />}
              label={t('email_viewer.previous', 'Prev')}
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
              label={t('email_viewer.next', 'Next')}
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
        canArchive={canArchive}
        canMarkUnread={true}
        canMove={!!sourceMailbox}
        showSpam={canToggleSpam}
        isInJunk={isInJunk}
        canViewSource={!!email?.blobId}
        canExport={!!email?.blobId}
        canTag={keywordDefs.length > 0}
        renderDark={activeRenderDark}
        hasSender={!!email?.from?.[0]?.email}
        onArchive={() => { setMoreMenuOpen(false); onArchive(); }}
        onToggleUnread={() => { setMoreMenuOpen(false); onToggleUnread(); }}
        onMove={() => { setMoreMenuOpen(false); setMoveMenuOpen(true); }}
        onTag={() => { setMoreMenuOpen(false); setTagMenuOpen(true); }}
        onToggleSpam={onToggleSpam}
        onToggleTheme={() => {
          setMoreMenuOpen(false);
          if (!email) return;
          setThemeOverrides((prev) => ({ ...prev, [email.id]: activeRenderDark ? 'light' : 'dark' }));
        }}
        onSenderActions={() => {
          setMoreMenuOpen(false);
          const from = email?.from?.[0];
          if (from) setAddressSheet(from);
        }}
        onForwardAsAttachment={onForwardAsAttachment}
        onViewSource={() => {
          setMoreMenuOpen(false);
          if (email?.blobId) {
            navigation.navigate('EmailSource', {
              emailId: email.id,
              blobId: email.blobId,
              subject: email.subject,
              jmapAccountId: ownerAccountId,
            });
          }
        }}
        onExport={async () => {
          setMoreMenuOpen(false);
          if (!email?.blobId) return;
          try {
            await shareEmailEml(email.blobId, email, undefined, ownerAccountId);
          } catch (e) {
            Alert.alert(t('email_viewer.export_failed', 'Export failed'), e instanceof Error ? e.message : String(e));
            return;
          }
          // Post-export action (webmail `postExportAction`): file the message
          // away once the export is out.
          if (postExportAction === 'archive') onArchive();
          else if (postExportAction === 'trash') onDelete();
        }}
      />

      <MoveSheet
        visible={moveMenuOpen}
        onClose={() => setMoveMenuOpen(false)}
        mailboxes={scopedMailboxes}
        currentMailboxId={sourceMailbox?.id ?? null}
        onPick={onMoveToMailbox}
      />

      <TagMenuSheet
        visible={tagMenuOpen}
        onClose={() => setTagMenuOpen(false)}
        keywords={keywordDefs}
        activeKeywords={email?.keywords ?? {}}
        onToggle={onToggleKeyword}
      />

      <AddressActionSheet address={addressSheet} onClose={() => setAddressSheet(null)} />

      {/* The list's host sits under this screen; failures in here need their own. */}
      <ToastHost />
    </SafeAreaView>
  );
}

interface EmailPaneProps {
  id: string;
  /** The page on screen; its neighbours are only pre-rendered. */
  active: boolean;
  /** May fetch its conversation and mount its body WebViews (see neighboursReady). */
  bodyEnabled: boolean;
  /** The page's body loaded and reported its height. */
  onBodySettled?: () => void;
  threadIdHint?: string;
  email: Email | null;
  /** The page as the pager lists it: a list row, or just the id for one handed over by id. */
  row: Email;
  /** Ids of the whole conversation (oldest first) once fetched; null = not (yet) loaded. */
  threadIds: string[] | null;
  /** A conversation member: its full copy when held, else its header. */
  memberOf: (threadId: string, id: string) => Email | undefined;
  /** How many messages the list says the conversation has, when it knows. */
  threadSizeHint?: number;
  threading: boolean;
  jmapAccountId?: string;
  currentMailboxRole: string | null;
  identities: Identity[];
  themeOverrides: Record<string, 'light' | 'dark'>;
  ensureDetail: (id: string) => Promise<Email | null>;
  ensureDetails: (ids: string[]) => void;
  ensureThread: (threadId: string) => void;
  scheduleMarkRead: (email: Email) => () => void;
  styles: ReturnType<typeof makeStyles>;
  bottomBarHeight: number;
  onToggleStar: (email: Email) => void;
  onAddressPress: (address: EmailAddress) => void;
  onEmailPatched: (email: Email) => void;
  onReply: (mode: 'reply' | 'replyAll' | 'forward', email: Email) => void;
  onSwipe: (direction: 'prev' | 'next') => void;
  onZoomChange: (zoom: { pinching: boolean; zoomed: boolean }) => void;
}

// One swipeable page: the subject plus either a single message or the whole
// conversation as collapsible cards (newest + unread expanded, mark-read on
// expand). The pager keeps three of these mounted (prev, current, next) so a
// swipe slides ready content into view. A conversation is listed from its
// members' headers; bodies are only downloaded for the cards that are open.
function EmailPane({
  id, active, bodyEnabled, onBodySettled, threadIdHint, email, row, threadIds, memberOf, threadSizeHint,
  threading, jmapAccountId, currentMailboxRole, identities, themeOverrides, ensureDetail, ensureDetails,
  ensureThread, scheduleMarkRead, styles, bottomBarHeight, onToggleStar, onAddressPress,
  onEmailPatched, onReply, onSwipe, onZoomChange,
}: EmailPaneProps) {
  const c = useColors();
  const t = useLocaleStore((s) => s.t);
  // Freeze the pane's vertical scroll while a pinch is in flight so a two-
  // finger zoom can't fling the page.
  const [pinching, setPinching] = React.useState(false);
  // Which cards are open. Seeded once the conversation arrives: the opened
  // message, the newest one and every unread one, like the webmail.
  const [expanded, setExpanded] = React.useState<Set<string> | null>(null);
  const readTimers = React.useRef(new Map<string, () => void>()).current;

  // The screen loads the neighbours' details itself, both in one request.
  React.useEffect(() => {
    if (!email && active) void ensureDetail(id);
  }, [id, email, active, ensureDetail]);

  // Also run for a conversation already held: it is checked against the
  // account's Email state (and refetched only when that moved on).
  const threadId = email?.threadId ?? threadIdHint;
  React.useEffect(() => {
    if (threading && threadId && bodyEnabled) ensureThread(threadId);
  }, [threading, threadId, bodyEnabled, ensureThread]);

  // Seeded once the message itself is known: before that `threadId` may be
  // a guess (a page handed over by id only carries the opened one's).
  React.useEffect(() => {
    if (!email || !threadIds || !threadId || expanded) return;
    const seed = new Set<string>();
    for (const mid of threadIds) {
      const m = memberOf(threadId, mid);
      if (m && !m.keywords?.$seen) seed.add(mid);
    }
    seed.add(id);
    if (threadIds.length > 0) seed.add(threadIds[threadIds.length - 1]);
    setExpanded(seed);
  }, [email, threadIds, threadId, expanded, memberOf, id]);

  // Bodies of the open cards, in one request.
  React.useEffect(() => {
    if (bodyEnabled && expanded && threadIds && threadIds.length > 1) {
      ensureDetails(threadIds.filter((mid) => expanded.has(mid)));
    }
  }, [bodyEnabled, expanded, threadIds, ensureDetails]);

  React.useEffect(() => () => { readTimers.forEach((cancel) => cancel()); readTimers.clear(); }, [readTimers]);

  const toggleCard = (mid: string) => {
    setExpanded((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(mid)) {
        next.delete(mid);
      } else {
        next.add(mid);
        const m = threadId ? memberOf(threadId, mid) : undefined;
        if (m && mid !== id) {
          readTimers.get(mid)?.();
          readTimers.set(mid, scheduleMarkRead(m));
        }
      }
      return next;
    });
  };

  // Until the message itself is here, its list row paints the subject and
  // header (sender, date, avatar); only a page handed over by id alone
  // (notification, deep link) starts as a skeleton.
  const shown = email ?? (row.receivedAt ? row : null);
  if (!shown) {
    return <EmailPaneSkeleton styles={styles} />;
  }

  const subject = singleLine(shown.subject) || t('email_viewer.no_subject', '(No Subject)');
  const conversation = threading && threadId && threadIds && threadIds.length > 1
    ? threadIds.map((mid) => memberOf(threadId, mid)).filter((m): m is Email => !!m)
    : null;
  const threadLoading = threading && !!threadId && !threadIds;
  // While the conversation loads, the size the list knows for it holds the
  // older cards' places, so the opened message does not move when they come.
  const pendingCards = !conversation && threadLoading && threadSizeHint && threadSizeHint > 1
    ? threadSizeHint - 1
    : 0;
  const asConversation = !!conversation || pendingCards > 0;
  // A single message goes through the same card list (bare), so its content
  // and WebView stay mounted when a conversation arrives around it.
  const members = conversation ?? [shown];
  const newest = conversation ? conversation[conversation.length - 1] : email;
  // The quick reply quotes the message, so it waits for the newest one's body.
  const newestLoaded = !!newest && !!peekDetail(newest.id, jmapAccountId);
  const onPaneZoom = (z: { pinching: boolean; zoomed: boolean }) => {
    setPinching(z.pinching);
    onZoomChange(z);
  };

  return (
    <ScrollView
      style={styles.scroll}
      // At least a page tall: a single message's body takes the space below
      // its header, and the quick reply stays at the bottom however the body
      // grows or shrinks once it has measured itself.
      contentContainerStyle={[styles.paneContent, { paddingBottom: bottomBarHeight + spacing.lg }]}
      scrollEnabled={!pinching}
    >
      {/* Subject block */}
      <View style={styles.subjectBlock}>
        <View style={styles.subjectRow}>
          <Text style={styles.subjectText}>{subject}</Text>
          {/* In the row, so the page does not shift when the conversation arrives. */}
          {threadLoading && (
            <ActivityIndicator
              size="small"
              color={c.textMuted}
              style={styles.subjectSpinner}
              accessibilityLabel={t('threads.loading', 'Loading conversation...')}
            />
          )}
          {asConversation ? (
            <View style={styles.threadCount}>
              <Text style={styles.threadCountText}>{conversation ? conversation.length : threadSizeHint}</Text>
            </View>
          ) : (
            <Pressable
              onPress={email ? () => onToggleStar(email) : undefined}
              hitSlop={8}
              style={styles.subjectStar}
            >
              <Star
                size={18}
                color={shown.keywords?.$flagged ? c.starred : c.textMuted}
                fill={shown.keywords?.$flagged ? c.starred : 'transparent'}
              />
            </Pressable>
          )}
        </View>
      </View>

      <View style={asConversation ? undefined : styles.paneFill}>
        {Array.from({ length: pendingCards }, (_, i) => <ThreadCardPlaceholder key={`pending-${i}`} />)}
        {members.map((m) => {
          const open = !asConversation || (expanded?.has(m.id) ?? m.id === id);
          // An open card without its body yet shows its header over placeholder lines.
          const full = peekDetail(m.id, jmapAccountId);
          return (
            <ThreadMessageCard
              key={m.id}
              bare={!asConversation}
              fill={!asConversation}
              email={full ?? m}
              expanded={open}
              replyable={!!full}
              deferBody={!full || !bodyEnabled}
              onBodySettled={onBodySettled}
              onToggleExpanded={() => toggleCard(m.id)}
              onReply={onReply}
              jmapAccountId={jmapAccountId}
              identities={identities}
              currentMailboxRole={currentMailboxRole}
              active={active}
              themeOverride={themeOverrides[m.id] ?? null}
              onSwipe={onSwipe}
              onZoomChange={onPaneZoom}
              onToggleStar={onToggleStar}
              onAddressPress={onAddressPress}
              onEmailPatched={onEmailPatched}
            />
          );
        })}
      </View>

      <View style={styles.quickReplySlot}>
        {newest && newestLoaded && (
          <QuickReplyBox
            email={newest}
            jmapAccountId={jmapAccountId}
            onMoreOptions={() => onReply('reply', newest)}
            onSent={onEmailPatched}
          />
        )}
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
        <View style={[styles.skeletonBone, { height: 20, width: '88%' }]} />
      </View>
      <View style={styles.skeletonSender}>
        <View style={styles.skeletonAvatar} />
        <View style={{ flex: 1 }}>
          <View style={[styles.skeletonBone, { height: 14, width: '55%' }]} />
          <View style={[styles.skeletonBone, { height: 11, width: '70%', marginTop: 6 }]} />
          <View style={[styles.skeletonBone, { height: 11, width: '45%', marginTop: 6 }]} />
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
  renderDark: boolean;
  hasSender: boolean;
  onArchive: () => void;
  onToggleUnread: () => void;
  onMove: () => void;
  onTag: () => void;
  onToggleSpam: () => void;
  onToggleTheme: () => void;
  onSenderActions: () => void;
  onForwardAsAttachment: () => void;
  onViewSource: () => void;
  onExport: () => void;
}

function MoreMenuSheet({
  visible, onClose, unread, canArchive, canMarkUnread, canMove, canTag,
  showSpam, isInJunk, canViewSource, canExport, renderDark, hasSender,
  onArchive, onToggleUnread, onMove, onTag, onToggleSpam, onToggleTheme, onSenderActions,
  onForwardAsAttachment, onViewSource, onExport,
}: MoreMenuSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const insets = useSafeAreaInsets();
  const slideY = React.useRef(new Animated.Value(600)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({ slideY, closedY: 600, onClose });

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 600, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
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
            <Text style={styles.sheetTitle}>{t('email_viewer.more_actions', 'More actions')}</Text>
            <Pressable onPress={onClose} hitSlop={8} style={styles.sheetClose}>
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
        <ScrollView style={styles.sheetScroll} bounces={false}>
          {canArchive && (
            <MoreMenuItem
              icon={<Archive size={18} color={c.textSecondary} />}
              label={t('email_viewer.archive', 'Archive')}
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
              label={unread ? t('email_viewer.mark_read', 'Mark as read') : t('email_viewer.mark_unread', 'Mark as unread')}
              onPress={onToggleUnread}
            />
          )}
          {canMove && (
            <MoreMenuItem
              icon={<FolderInput size={18} color={c.textSecondary} />}
              label={t('email_viewer.move_to', 'Move to...')}
              onPress={onMove}
              trailing={<ChevronRight size={16} color={c.textMuted} />}
            />
          )}
          {canTag && (
            <MoreMenuItem
              icon={<Tag size={18} color={c.textSecondary} />}
              label={t('email_viewer.set_tag', 'Set tag')}
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
              label={isInJunk ? t('email_viewer.not_spam_short', 'Not spam') : t('email_viewer.spam.button_title', 'Report spam')}
              onPress={onToggleSpam}
            />
          )}
          <MoreMenuItem
            icon={renderDark ? <Sun size={18} color={c.textSecondary} /> : <Moon size={18} color={c.textSecondary} />}
            label={renderDark ? t('email_viewer.view_light_mode', 'View in light mode') : t('email_viewer.view_dark_mode', 'View in dark mode')}
            onPress={onToggleTheme}
          />
          {hasSender && (
            <MoreMenuItem
              icon={<UserRoundPlus size={18} color={c.textSecondary} />}
              label={t('email_viewer.sender_actions', 'Sender…')}
              onPress={onSenderActions}
              trailing={<ChevronRight size={16} color={c.textMuted} />}
            />
          )}
          {canExport && (
            <MoreMenuItem
              icon={<FileInput size={18} color={c.textSecondary} />}
              label={t('email_viewer.forward_as_attachment', 'Forward as attachment')}
              onPress={onForwardAsAttachment}
            />
          )}
          {canViewSource && (
            <MoreMenuItem
              icon={<Code size={18} color={c.textSecondary} />}
              label={t('email_viewer.view_source', 'View source')}
              onPress={onViewSource}
            />
          )}
          {canExport && (
            <MoreMenuItem
              icon={<Download size={18} color={c.textSecondary} />}
              label={t('email_viewer.export_email', 'Export as .eml')}
              onPress={onExport}
            />
          )}
        </ScrollView>
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
  const t = useLocaleStore((s) => s.t);
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
            <Text style={styles.sheetTitle}>{t('email_viewer.tag', 'Tag')}</Text>
            <Pressable onPress={onClose} hitSlop={8} style={styles.sheetClose}>
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
        {keywords.length === 0 ? (
          <Text style={{ ...typography.body, color: c.textMuted, paddingVertical: spacing.lg, paddingHorizontal: spacing.lg }}>
            {t('email_viewer.tag_no_matches', 'No matching tags')}
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
  threadCount: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    paddingHorizontal: 6,
    backgroundColor: c.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  threadCountText: { ...typography.small, color: c.textSecondary, fontWeight: '600' },
  subjectSpinner: { marginTop: 6 },
  paneContent: { flexGrow: 1 },
  paneFill: { flexGrow: 1 },
  quickReplySlot: { marginTop: 'auto' },

  // Loading skeleton
  skeletonBone: {
    backgroundColor: c.surfaceHover,
    borderRadius: radius.xs,
  },
  skeletonSender: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
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

  // Bottom sheet (More menu / Tag picker)
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
    maxHeight: '85%',
    backgroundColor: c.popover,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    borderColor: c.border,
    paddingTop: spacing.sm,
  },
  sheetScroll: { flexGrow: 0 },
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
