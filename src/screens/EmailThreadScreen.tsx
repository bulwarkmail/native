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
import { MessageContent } from '../components/email/MessageContent';
import { ThreadMessageCard } from '../components/email/ThreadMessageCard';
import { QuickReplyBox } from '../components/email/QuickReplyBox';
import { AddressActionSheet } from '../components/email/AddressActionSheet';
import { useEmailStore } from '../stores/email-store';
import {
  useSettingsStore,
  normalizeBottomQuickActions,
  REPLY_QUICK_ACTIONS,
  type QuickAction,
} from '../stores/settings-store';
import { patchKeywordsForEmails, getThreadEmails } from '../api/email';
import { shareEmailEml } from '../lib/email-export';
import { useKeywordsStore, keywordToken, type KeywordDef } from '../stores/keywords-store';
import { useSheetDrag } from '../lib/use-sheet-drag';
import { useLocaleStore } from '../stores/locale-store';
import { findTrashMailbox, mailboxesForSiblingOf } from '../lib/mailbox-tree';
import { pickEmailBody, plainTextBody } from '../lib/email-body';
import { buildForwardAsAttachmentPayload } from '../lib/forward-as-attachment';
import type { Email, EmailAddress, Identity } from '../api/types';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'EmailThread'>;

export default function EmailThreadScreen({ route, navigation }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { t } = useLocaleStore();
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
  const storeEmails = useEmailStore((s) => s.emails);
  const disableThreading = useSettingsStore((s) => s.disableThreading);
  const identities = useSettingsStore((s) => s.identities);
  const fetchIdentities = useSettingsStore((s) => s.fetchIdentities);
  const deleteAction = useSettingsStore((s) => s.deleteAction);
  const permanentlyDeleteJunk = useSettingsStore((s) => s.permanentlyDeleteJunk);
  const postExportAction = useSettingsStore((s) => s.postExportAction);
  const emailAlwaysLightMode = useSettingsStore((s) => s.emailAlwaysLightMode);
  const exportSpaceReplacement = useSettingsStore((s) => s.exportSpaceReplacement);
  const exportLowercase = useSettingsStore((s) => s.exportLowercase);
  const exportStripDiacritics = useSettingsStore((s) => s.exportStripDiacritics);
  const resolvedTheme = useResolvedTheme();
  React.useEffect(() => { if (identities.length === 0) void fetchIdentities(); }, [identities.length, fetchIdentities]);

  // The list the pager pages over. A message opened from the active folder
  // pages over that folder (collapsed to one page per thread when threading
  // is on, the opened message standing in for its thread); one opened from
  // another list (unified inbox, contact activity) pages over the ids that
  // list handed us, and a message that is in neither (e.g. a group-inbox
  // message not in the folder page) gets a one-element list — otherwise the
  // pager would render `emails[0]` while the toolbar acted on the tapped one.
  const emails = React.useMemo<Email[]>(() => {
    const { emailIds, emailId, threadId } = route.params;
    if (emailIds && emailIds.length > 0) {
      const byId = jmapAccountId ? null : new Map(storeEmails.map((e) => [e.id, e]));
      return emailIds.map((id) => byId?.get(id) ?? ({ id, threadId } as Email));
    }
    const opened = jmapAccountId ? undefined : storeEmails.find((e) => e.id === emailId);
    if (opened) {
      if (disableThreading) return storeEmails;
      const openedKey = opened.threadId || opened.id;
      const seen = new Set<string>();
      const out: Email[] = [];
      for (const e of storeEmails) {
        const key = e.threadId || e.id;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key === openedKey ? opened : e);
      }
      return out;
    }
    return [{ id: emailId, threadId } as Email];
  }, [storeEmails, route.params, jmapAccountId, disableThreading]);

  // The JMAP account the open message belongs to: the route param when the
  // unified inbox opened a group message, otherwise the account behind the
  // folder it was opened from. Undefined means the user's own mail.
  const ownerAccountId = React.useMemo(() => {
    if (jmapAccountId) return jmapAccountId;
    const current = currentMailboxId
      ? mailboxes.find((m) => m.id === currentMailboxId)
      : undefined;
    return current?.isShared ? current.accountId : undefined;
  }, [jmapAccountId, mailboxes, currentMailboxId]);
  const currentMailboxRole = React.useMemo(
    () => (currentMailboxId ? mailboxes.find((m) => m.id === currentMailboxId)?.role ?? null : null),
    [mailboxes, currentMailboxId],
  );

  const currentIndex = emails.findIndex((e) => e.id === activeEmailId);
  const prevEmail = currentIndex > 0 ? emails[currentIndex - 1] : null;
  const nextEmail = currentIndex >= 0 && currentIndex < emails.length - 1 ? emails[currentIndex + 1] : null;

  const [error, setError] = React.useState<string | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = React.useState(false);
  const [moveMenuOpen, setMoveMenuOpen] = React.useState(false);
  const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
  const [addressSheet, setAddressSheet] = React.useState<EmailAddress | null>(null);
  // Per-message override of the light/dark rendering (More sheet toggle).
  const [themeOverrides, setThemeOverrides] = React.useState<Record<string, 'light' | 'dark'>>({});

  // In-memory cache of fetched message details keyed by id. This is the single
  // source of truth for every rendered pane: the active message *and* its
  // prefetched neighbours all read their detail from here, so a swipe lands on
  // ready content with no spinner and no late content-swap. `cacheVersion` is
  // bumped whenever an entry changes so the panes re-render.
  const detailCache = React.useRef(new Map<string, Email>()).current;
  // Thread id -> message ids (oldest first), once the conversation was fetched.
  const threadCache = React.useRef(new Map<string, string[]>()).current;
  const [cacheVersion, setCacheVersion] = React.useState(0);
  const bumpCache = React.useCallback(() => setCacheVersion((v) => v + 1), []);
  const email = React.useMemo(
    () => detailCache.get(activeEmailId) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeEmailId, cacheVersion, detailCache],
  );

  // --- Pager -------------------------------------------------------------
  // A horizontal, page-snapping FlatList over `emails`. Native scroll provides
  // the swipe + snap; Prev/Next scroll programmatically. When scrolling
  // settles, the centred page's id becomes `activeEmailId`, which is what the
  // toolbar and action handlers operate on.
  const listRef = React.useRef<FlatList<Email>>(null);
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
    const p = getEmailDetail(id, ownerAccountId)
      .then((fetched) => { detailCache.set(id, fetched); bumpCache(); return fetched; })
      .catch(() => detailCache.get(id) ?? null)
      .finally(() => { inFlight.delete(id); });
    inFlight.set(id, p);
    return p;
  }, [getEmailDetail, ownerAccountId, detailCache, bumpCache, inFlight]);

  // Whole conversation (Thread/get -> Email/get), cached per thread id. Every
  // message lands in the detail cache so the cards render straight from it.
  const threadInFlight = React.useRef(new Map<string, Promise<string[]>>()).current;
  const ensureThread = React.useCallback((threadId: string): Promise<string[]> => {
    const cached = threadCache.get(threadId);
    if (cached) return Promise.resolve(cached);
    const pending = threadInFlight.get(threadId);
    if (pending) return pending;
    const p = getThreadEmails(threadId, ownerAccountId)
      .then((list) => {
        for (const e of list) detailCache.set(e.id, e);
        const ids = list.map((e) => e.id);
        threadCache.set(threadId, ids);
        bumpCache();
        return ids;
      })
      .catch((err) => {
        console.warn('[thread] fetch failed', err);
        // Fall back to the single message so the pane still renders.
        const single = detailCache.has(activeEmailId) ? [activeEmailId] : [];
        threadCache.set(threadId, single);
        bumpCache();
        return single;
      })
      .finally(() => { threadInFlight.delete(threadId); });
    threadInFlight.set(threadId, p);
    return p;
  }, [ownerAccountId, detailCache, threadCache, bumpCache, threadInFlight, activeEmailId]);

  const goToIndex = React.useCallback((index: number) => {
    if (index < 0 || index >= emails.length) return;
    listRef.current?.scrollToOffset({ offset: index * windowWidth, animated: true });
    const target = emails[index];
    if (target) setActiveEmailId(target.id);
  }, [emails, windowWidth]);

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
  // of truth for every pane) and bump the version so the panes re-render.
  const updateLocalKeywords = React.useCallback((id: string, next: Record<string, boolean>) => {
    const prev = detailCache.get(id);
    if (!prev) return;
    detailCache.set(id, { ...prev, keywords: next });
    bumpCache();
  }, [detailCache, bumpCache]);

  // Mark a message read per the user's delay setting: -1 never, 0 instantly,
  // >0 after that many milliseconds. Returns a cancel function.
  const scheduleMarkRead = React.useCallback((target: Email): (() => void) => {
    if (target.keywords?.$seen || markAsReadDelay === -1) return () => undefined;
    const apply = () => {
      updateLocalKeywords(target.id, { ...target.keywords, $seen: true });
      void markRead(target.id, ownerAccountId);
    };
    if (markAsReadDelay > 0) {
      const timer = setTimeout(apply, markAsReadDelay);
      return () => clearTimeout(timer);
    }
    apply();
    return () => undefined;
  }, [markAsReadDelay, markRead, ownerAccountId, updateLocalKeywords]);

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
        if (!detailCache.has(activeEmailId)) setError(t('email_viewer.load_failed', 'Failed to load email'));
        return;
      }
      cancelRead = scheduleMarkRead(fetched);
    })();
    return () => {
      cancelled = true;
      cancelRead?.();
    };
  }, [activeEmailId, ensureDetail, scheduleMarkRead, detailCache, t]);

  const starred = !!email?.keywords?.$flagged;
  const unread = !!email && !email.keywords?.$seen;

  // Move/archive/spam targets have to live in the same account as the folder
  // the message was opened from.
  const scopedMailboxes = React.useMemo(
    () => mailboxesForSiblingOf(mailboxes, currentMailboxId),
    [mailboxes, currentMailboxId],
  );
  const archiveMailbox = React.useMemo(
    () => scopedMailboxes.find((m) => m.role === 'archive'),
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
  const isInTrash = !!(trashMailbox && currentMailboxId === trashMailbox.id);

  const onToggleKeyword = (token: string) => {
    if (!email) return;
    const next = { ...email.keywords };
    if (next[token]) delete next[token];
    else next[token] = true;
    updateLocalKeywords(email.id, next);
    void patchKeywordsForEmails([email.id], { [token]: next[token] ?? null }, ownerAccountId);
  };

  // Toggle the star on a specific message — used both by the toolbar (current
  // message) and by each pane's own subject star / card header.
  const toggleStarFor = React.useCallback((target: Email) => {
    const next = { ...target.keywords };
    if (next.$flagged) delete next.$flagged;
    else next.$flagged = true;
    updateLocalKeywords(target.id, next);
    void patchKeywordsForEmails([target.id], { $flagged: next.$flagged ?? null }, ownerAccountId);
  }, [updateLocalKeywords, ownerAccountId]);

  const onToggleStar = () => { if (email) toggleStarFor(email); };

  const onToggleUnread = () => {
    if (!email) return;
    if (unread) {
      void markRead(email.id, ownerAccountId);
      updateLocalKeywords(email.id, { ...email.keywords, $seen: true });
    } else {
      const next = { ...email.keywords };
      delete next.$seen;
      updateLocalKeywords(email.id, next);
      void patchKeywordsForEmails([email.id], { $seen: null }, ownerAccountId);
    }
  };

  const onEmailPatched = React.useCallback((patched: Email) => {
    detailCache.set(patched.id, patched);
    bumpCache();
  }, [detailCache, bumpCache]);

  const performDelete = () => {
    if (!email || !currentMailboxId || !trashMailbox) return;
    void deleteEmail(email.id, trashMailbox.id, currentMailboxId);
    navigation.goBack();
  };

  const onDelete = () => {
    if (!email || !currentMailboxId) return;
    if (!trashMailbox) {
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
    if (!email || !currentMailboxId || !archiveMailbox) return;
    if (currentMailboxId === archiveMailbox.id) return;
    void archiveEmailAction(email.id);
    navigation.goBack();
  };

  const onToggleSpam = () => {
    if (!email || !currentMailboxId) return;
    setMoreMenuOpen(false);
    if (isInJunk) {
      const target = inboxMailbox ?? scopedMailboxes.find((m) => m.id !== currentMailboxId);
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
      available: !!archiveMailbox && currentMailboxId !== archiveMailbox?.id,
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
      available: mailboxes.length > 0,
    },
    spam: {
      label: isInJunk ? t('email_viewer.not_spam_short', 'Not spam') : t('email_viewer.spam_short', 'Spam'),
      icon: (s, col) =>
        isInJunk ? <ShieldCheck size={s} color={c.success} /> : <ShieldAlert size={s} color={col} />,
      onPress: onToggleSpam,
      available: !!junkMailbox || isInJunk,
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
  const showArchive = windowWidth >= 400 && !!archiveMailbox;

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
            scrollEnabled={!pagerLocked}
            onMomentumScrollEnd={onMomentumEnd}
            renderItem={({ item, index }) => (
              <View style={{ width: windowWidth }}>
                <EmailPane
                  id={item.id}
                  active={item.id === activeEmailId}
                  threadIdHint={item.threadId}
                  email={detailCache.get(item.id) ?? null}
                  detailCache={detailCache}
                  threadIds={
                    !disableThreading
                      ? threadCache.get(detailCache.get(item.id)?.threadId ?? item.threadId) ?? null
                      : null
                  }
                  threading={!disableThreading}
                  jmapAccountId={ownerAccountId}
                  currentMailboxRole={currentMailboxRole}
                  identities={identities}
                  themeOverrides={themeOverrides}
                  ensureDetail={ensureDetail}
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
        canArchive={!!archiveMailbox && currentMailboxId !== archiveMailbox?.id}
        canMarkUnread={true}
        canMove={mailboxes.length > 0}
        showSpam={!!junkMailbox || isInJunk}
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

      <AddressActionSheet address={addressSheet} onClose={() => setAddressSheet(null)} />
    </SafeAreaView>
  );
}

interface EmailPaneProps {
  id: string;
  /** The page on screen; its neighbours are only pre-rendered. */
  active: boolean;
  threadIdHint?: string;
  email: Email | null;
  detailCache: Map<string, Email>;
  /** Ids of the whole conversation (oldest first) once fetched; null = not (yet) loaded. */
  threadIds: string[] | null;
  threading: boolean;
  jmapAccountId?: string;
  currentMailboxRole: string | null;
  identities: Identity[];
  themeOverrides: Record<string, 'light' | 'dark'>;
  ensureDetail: (id: string) => Promise<Email | null>;
  ensureThread: (threadId: string) => Promise<string[]>;
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
// swipe slides ready content into view.
function EmailPane({
  id, active, threadIdHint, email, detailCache, threadIds, threading, jmapAccountId, currentMailboxRole,
  identities, themeOverrides, ensureDetail, ensureThread, scheduleMarkRead, styles, bottomBarHeight,
  onToggleStar, onAddressPress, onEmailPatched, onReply, onSwipe, onZoomChange,
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

  React.useEffect(() => {
    if (!email) void ensureDetail(id);
  }, [id, email, ensureDetail]);

  const threadId = email?.threadId ?? threadIdHint;
  React.useEffect(() => {
    if (threading && threadId && !threadIds) void ensureThread(threadId);
  }, [threading, threadId, threadIds, ensureThread]);

  React.useEffect(() => {
    if (!threadIds || expanded) return;
    const seed = new Set<string>();
    for (const mid of threadIds) {
      const m = detailCache.get(mid);
      if (m && !m.keywords?.$seen) seed.add(mid);
    }
    seed.add(id);
    if (threadIds.length > 0) seed.add(threadIds[threadIds.length - 1]);
    setExpanded(seed);
  }, [threadIds, expanded, detailCache, id]);

  React.useEffect(() => () => { readTimers.forEach((cancel) => cancel()); readTimers.clear(); }, [readTimers]);

  const toggleCard = (mid: string) => {
    setExpanded((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(mid)) {
        next.delete(mid);
      } else {
        next.add(mid);
        const m = detailCache.get(mid);
        if (m && mid !== id) {
          readTimers.get(mid)?.();
          readTimers.set(mid, scheduleMarkRead(m));
        }
      }
      return next;
    });
  };

  if (!email) {
    return <EmailPaneSkeleton styles={styles} />;
  }

  const subject = email.subject || t('email_viewer.no_subject', '(No Subject)');
  const conversation = threading && threadIds && threadIds.length > 1
    ? threadIds.map((mid) => detailCache.get(mid)).filter((m): m is Email => !!m)
    : null;
  const newest = conversation ? conversation[conversation.length - 1] : email;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={{ paddingBottom: bottomBarHeight + spacing.lg }}
      scrollEnabled={!pinching}
    >
      {/* Subject block */}
      <View style={styles.subjectBlock}>
        <View style={styles.subjectRow}>
          <Text style={styles.subjectText}>{subject}</Text>
          {conversation ? (
            <View style={styles.threadCount}>
              <Text style={styles.threadCountText}>{conversation.length}</Text>
            </View>
          ) : (
            <Pressable onPress={() => onToggleStar(email)} hitSlop={8} style={styles.subjectStar}>
              <Star
                size={18}
                color={email.keywords?.$flagged ? c.starred : c.textMuted}
                fill={email.keywords?.$flagged ? c.starred : 'transparent'}
              />
            </Pressable>
          )}
        </View>
      </View>

      {threading && threadId && !threadIds && (
        <View style={styles.threadLoading}>
          <ActivityIndicator size="small" color={c.textMuted} />
          <Text style={styles.threadLoadingText}>{t('threads.loading', 'Loading conversation...')}</Text>
        </View>
      )}

      {conversation ? (
        conversation.map((m) => (
          <ThreadMessageCard
            key={m.id}
            email={m}
            expanded={expanded?.has(m.id) ?? m.id === id}
            onToggleExpanded={() => toggleCard(m.id)}
            onReply={onReply}
            jmapAccountId={jmapAccountId}
            identities={identities}
            currentMailboxRole={currentMailboxRole}
            active={active}
            themeOverride={themeOverrides[m.id] ?? null}
            onSwipe={onSwipe}
            onZoomChange={(z) => { setPinching(z.pinching); onZoomChange(z); }}
            onToggleStar={onToggleStar}
            onAddressPress={onAddressPress}
            onEmailPatched={onEmailPatched}
          />
        ))
      ) : (
        <MessageContent
          email={email}
          jmapAccountId={jmapAccountId}
          identities={identities}
          currentMailboxRole={currentMailboxRole}
          active={active}
          themeOverride={themeOverrides[email.id] ?? null}
          onSwipe={onSwipe}
          onZoomChange={(z) => { setPinching(z.pinching); onZoomChange(z); }}
          onAddressPress={onAddressPress}
          onEmailPatched={onEmailPatched}
        />
      )}

      <QuickReplyBox
        email={newest}
        jmapAccountId={jmapAccountId}
        onMoreOptions={() => onReply('reply', newest)}
        onSent={onEmailPatched}
      />
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
  threadLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  threadLoadingText: { ...typography.caption, color: c.textMuted },

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
