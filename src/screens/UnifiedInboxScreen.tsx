import React from 'react';
import {
  View, Text, StyleSheet, FlatList, ActivityIndicator, Pressable, TextInput, Alert, AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import {
  ArrowLeft, Star, Paperclip, AlertTriangle, Search, X, Square, SquareCheck,
  Mail as MailIcon, MailOpen, Archive, Trash2, ShieldAlert, ShieldCheck, Folder,
} from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import SenderAvatar from '../components/SenderAvatar';
import { SwipeableRow } from '../components/SwipeableRow';
import {
  fetchUnifiedInbox, patchUnifiedKeywords, moveUnifiedEmails, deleteUnifiedEmails, isInUnifiedTrash,
  type UnifiedEmail, type UnifiedRole, type CrossView,
} from '../api/unified-inbox';
import { useAccountStore } from '../stores/account-store';
import { useAuthStore } from '../stores/auth-store';
import { useSettingsStore, type SwipeAction } from '../stores/settings-store';
import { useLocaleStore } from '../stores/locale-store';
import { formatListDate } from '../lib/date-format';
import { singleLine } from '../lib/single-line';
import { prefetchMessage, rememberRows } from '../lib/email-detail-cache';
import { isPermanentDelete, confirmPermanentDelete } from '../lib/delete-confirm';
import { onStateChangeType } from '../lib/state-change-bus';
import { createUnifiedReloadTracker } from '../lib/unified-reload';
import { spacing, typography, componentSizes, radius, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

type Props = NativeStackScreenProps<RootStackParamList, 'UnifiedInbox'>;

const PAGE_SIZE = 25;

function senderName(email: UnifiedEmail, showRecipient: boolean): string {
  if (showRecipient) {
    const to = email.to?.[0];
    if (to) return to.name || to.email;
  }
  return email.from?.[0]?.name || email.from?.[0]?.email || 'Unknown';
}

function rowKey(e: UnifiedEmail): string {
  return `${e.sourceAccountId}:${e.jmapAccountId}:${e.id}`;
}

export default function UnifiedInboxScreen({ navigation, route }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const role: UnifiedRole = route.params?.role ?? 'inbox';
  const view: CrossView | undefined = route.params?.view;
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const includeGroup = useSettingsStore((s) => s.includeGroupInUnified);
  const crossAccount = useSettingsStore((s) => s.unifiedCrossAccount);
  const deleteAction = useSettingsStore((s) => s.deleteAction);
  const permanentlyDeleteJunk = useSettingsStore((s) => s.permanentlyDeleteJunk);
  const swipeLeftAction = useSettingsStore((s) => s.swipeLeftAction);
  const swipeRightAction = useSettingsStore((s) => s.swipeRightAction);
  const swipeMode = useSettingsStore((s) => s.swipeMode);
  const showAvatarsInJunk = useSettingsStore((s) => s.showAvatarsInJunk);
  const locale = useLocaleStore((s) => s.locale);

  const [emails, setEmails] = React.useState<UnifiedEmail[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [opening, setOpening] = React.useState(false);
  const [searchInput, setSearchInput] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const positionsRef = React.useRef<Record<string, number>>({});
  const hasMoreRef = React.useRef(false);
  const loadSeq = React.useRef(0);
  const reloadTracker = React.useMemo(() => createUnifiedReloadTracker(), []);

  const accountById = React.useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );
  // Account-bounded by default (the active account + its shared/group
  // folders); every signed-in account only with the cross-account opt-in.
  const accountIds = React.useMemo(() => {
    if (crossAccount || !activeAccountId) return accounts.map((a) => a.id);
    return accounts.some((a) => a.id === activeAccountId) ? [activeAccountId] : accounts.map((a) => a.id);
  }, [accounts, activeAccountId, crossAccount]);

  const fetchOpts = React.useMemo(
    () => ({ includeGroup, query, role, view }),
    [includeGroup, query, role, view],
  );

  const load = React.useCallback(async () => {
    const seq = ++loadSeq.current;
    const active = useAuthStore.getState().activeAccountId;
    reloadTracker.loaded([accountIds, fetchOpts], active, accountIds.some((id) => id !== active));
    setLoading(true);
    try {
      const result = await fetchUnifiedInbox(accountIds, PAGE_SIZE, { ...fetchOpts, positions: {} });
      if (seq !== loadSeq.current) return;
      positionsRef.current = result.positions;
      hasMoreRef.current = result.hasMore;
      setEmails(result.emails);
      setErrors(result.errors);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [accountIds, fetchOpts, reloadTracker]);

  const loadMore = React.useCallback(async () => {
    if (loading || loadingMore || !hasMoreRef.current) return;
    const seq = loadSeq.current;
    setLoadingMore(true);
    try {
      const result = await fetchUnifiedInbox(accountIds, PAGE_SIZE, {
        ...fetchOpts,
        positions: positionsRef.current,
      });
      if (seq !== loadSeq.current) return;
      positionsRef.current = result.positions;
      hasMoreRef.current = result.hasMore;
      setEmails((prev) => {
        const seen = new Set(prev.map(rowKey));
        const merged = [...prev];
        for (const e of result.emails) if (!seen.has(rowKey(e))) merged.push(e);
        return merged.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
      });
    } finally {
      setLoadingMore(false);
    }
  }, [accountIds, fetchOpts, loading, loadingMore]);

  // Reload whenever the inputs change, and on coming back into focus only
  // when something may have changed meanwhile (a message read or deleted in
  // the thread screen); see createUnifiedReloadTracker.
  useFocusEffect(
    React.useCallback(() => {
      if (reloadTracker.focus([accountIds, fetchOpts], useAuthStore.getState().activeAccountId)) {
        void load();
      }
      return () => reloadTracker.blur();
    }, [load, accountIds, fetchOpts, reloadTracker]),
  );
  React.useEffect(() => {
    const offEmail = onStateChangeType('Email', () => {
      if (reloadTracker.changeArrived()) void load();
    });
    // The event stream is closed in the background: changes made meanwhile
    // are never reported.
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'background') reloadTracker.markStale();
    });
    return () => {
      offEmail();
      appState.remove();
    };
  }, [load, reloadTracker]);

  // Search on submit / after a pause (2+ chars), like the folder list.
  React.useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === query) return;
    if (trimmed.length > 0 && trimmed.length < 2) return;
    const id = setTimeout(() => setQuery(trimmed), 600);
    return () => clearTimeout(id);
  }, [searchInput, query]);

  const onOpen = React.useCallback(
    (email: UnifiedEmail) => {
      if (opening) return;
      setOpening(true);
      // The thread screen marks it read: show that when coming back.
      if (!email.keywords?.$seen) reloadTracker.markStale();
      void (async () => {
        try {
          const auth = useAuthStore.getState();
          if (auth.activeAccountId !== email.sourceAccountId) {
            await switchAccount(email.sourceAccountId);
            if (useAuthStore.getState().activeAccountId !== email.sourceAccountId) return;
          }
          // Page over the rows of the same account the user is looking at
          // (ids are only unique per JMAP account, so never mix accounts).
          const pages = emails
            .filter((e) => e.sourceAccountId === email.sourceAccountId && e.jmapAccountId === email.jmapAccountId);
          // Group/shared messages live under another JMAP account in the
          // same session; pass it so the thread opens against the right one.
          const jmapAccountId = email.isShared ? email.jmapAccountId : undefined;
          // The viewer paints these rows' headers, and starts on the body now.
          rememberRows(pages, jmapAccountId);
          prefetchMessage(email, jmapAccountId);
          navigation.navigate('EmailThread', {
            emailId: email.id,
            threadId: email.threadId,
            subject: email.subject,
            jmapAccountId,
            emailIds: pages.map((e) => e.id),
          });
        } finally {
          setOpening(false);
        }
      })();
    },
    [opening, switchAccount, navigation, emails, reloadTracker],
  );

  // ── Actions (routed to each message's own account) ────────────────────
  const removeRows = (targets: UnifiedEmail[]) => {
    const gone = new Set(targets.map(rowKey));
    setEmails((prev) => prev.filter((e) => !gone.has(rowKey(e))));
  };
  const patchRows = (targets: UnifiedEmail[], patch: Record<string, boolean | null>) => {
    const keys = new Set(targets.map(rowKey));
    setEmails((prev) => prev.map((e) => {
      if (!keys.has(rowKey(e))) return e;
      const keywords = { ...e.keywords };
      for (const [k, v] of Object.entries(patch)) {
        if (v) keywords[k] = true;
        else delete keywords[k];
      }
      return { ...e, keywords };
    }));
  };
  const fail = (err: unknown) => {
    Alert.alert(t('email_list.error', 'Error'), err instanceof Error ? err.message : String(err));
    void load();
  };

  const setRead = (targets: UnifiedEmail[], read: boolean) => {
    patchRows(targets, { $seen: read ? true : null });
    patchUnifiedKeywords(targets, { $seen: read ? true : null }).catch(fail);
  };
  const setStarred = (targets: UnifiedEmail[], starred: boolean) => {
    patchRows(targets, { $flagged: starred ? true : null });
    patchUnifiedKeywords(targets, { $flagged: starred ? true : null }).catch(fail);
  };
  const archive = (targets: UnifiedEmail[]) => {
    removeRows(targets);
    moveUnifiedEmails(targets, 'archive').catch(fail);
  };
  const spam = (targets: UnifiedEmail[]) => {
    removeRows(targets);
    moveUnifiedEmails(targets, role === 'junk' ? 'inbox' : 'junk', {
      markRead: role !== 'junk' && deleteAction === 'trash-and-read',
    }).catch(fail);
  };
  const remove = async (targets: UnifiedEmail[]) => {
    const permanent = targets.some((e) => isPermanentDelete({
      inTrash: role === 'trash' || isInUnifiedTrash(e),
      inJunk: role === 'junk',
      deleteAction,
      permanentlyDeleteJunk,
    }));
    if (permanent && !(await confirmPermanentDelete(targets.length, t))) return;
    removeRows(targets);
    deleteUnifiedEmails(targets, {
      permanent: deleteAction === 'permanent' || (permanentlyDeleteJunk && role === 'junk'),
      markRead: deleteAction === 'trash-and-read',
    }).catch(fail);
  };

  const handleSwipe = (email: UnifiedEmail, action: SwipeAction) => {
    switch (action) {
      case 'archive': if (role !== 'archive') archive([email]); break;
      case 'delete': void remove([email]); break;
      case 'spam': if (role !== 'sent' && role !== 'drafts') spam([email]); break;
      case 'read': setRead([email], !email.keywords?.$seen); break;
      case 'star': setStarred([email], !email.keywords?.$flagged); break;
      case 'pin':
        patchRows([email], { $pinned: email.keywords?.$pinned ? null : true });
        patchUnifiedKeywords([email], { $pinned: email.keywords?.$pinned ? null : true }).catch(fail);
        break;
      default: break;
    }
  };

  const selectionMode = selected.size > 0;
  const selectedEmails = React.useMemo(
    () => emails.filter((e) => selected.has(rowKey(e))),
    [emails, selected],
  );
  const toggleSelect = (email: UnifiedEmail) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = rowKey(email);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());
  const allRead = selectedEmails.length > 0 && selectedEmails.every((e) => !!e.keywords?.$seen);
  const allStarred = selectedEmails.length > 0 && selectedEmails.every((e) => !!e.keywords?.$flagged);

  const errorCount = Object.keys(errors).length;
  const showRecipient = role === 'sent' || role === 'drafts';
  const title = view
    ? t(`sidebar.unified_all_${view === 'all' ? 'mail' : view}`, { all: 'All mail', unread: 'All unread', starred: 'All starred' }[view])
    : role === 'inbox'
      ? t('sidebar.unified_inbox', 'All inboxes')
      : t(`sidebar.unified_${role}`, `All ${role}`);

  const renderItem = ({ item }: { item: UnifiedEmail }) => {
    const acc = accountById.get(item.sourceAccountId);
    const unread = !item.keywords?.$seen;
    const starred = !!item.keywords?.$flagged;
    const isSelected = selected.has(rowKey(item));
    return (
      <SwipeableRow
        leftAction={selectionMode ? 'none' : swipeLeftAction}
        rightAction={selectionMode ? 'none' : swipeRightAction}
        mode={swipeMode}
        context={{ unread, starred, pinned: !!item.keywords?.$pinned, inJunk: role === 'junk' }}
        onAction={(action) => handleSwipe(item, action)}
      >
        <Pressable
          onPress={() => (selectionMode ? toggleSelect(item) : onOpen(item))}
          onLongPress={() => toggleSelect(item)}
          delayLongPress={300}
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed, isSelected && styles.rowSelected]}
        >
          {unread && <View style={styles.unreadDot} />}
          {selectionMode && (
            <View style={styles.checkbox}>
              {isSelected ? <SquareCheck size={16} color={c.primary} /> : <Square size={16} color={c.textMuted} />}
            </View>
          )}
          <View style={styles.avatarWrap}>
            <SenderAvatar
              name={senderName(item, showRecipient)}
              email={showRecipient ? item.to?.[0]?.email : item.from?.[0]?.email}
              size={componentSizes.avatarMd}
              disableImages={role === 'junk' && !showAvatarsInJunk}
            />
            {acc && accountIds.length > 1 && (
              <View style={[styles.accountDot, { backgroundColor: acc.avatarColor }]} />
            )}
          </View>
          <View style={styles.content}>
            <View style={styles.line}>
              <Text style={[styles.sender, unread && styles.bold]} numberOfLines={1}>
                {senderName(item, showRecipient)}
              </Text>
              {starred && <Star size={12} color={c.starred} fill={c.starred} />}
              {item.hasAttachment && <Paperclip size={12} color={c.textMuted} />}
              <Text style={styles.time}>{formatListDate(item.receivedAt, { dateFormat, timeFormat, locale, t })}</Text>
            </View>
            <Text style={[styles.subject, unread && styles.bold]} numberOfLines={1}>
              {singleLine(item.subject) || t('email_viewer.no_subject', '(No Subject)')}
            </Text>
            <View style={styles.line}>
              {acc && accountIds.length > 1 && (
                <Text style={styles.account} numberOfLines={1}>
                  {acc.email || acc.username}
                </Text>
              )}
              {item.isShared && (
                <View style={styles.sharedBadge}>
                  <Text style={styles.sharedBadgeText} numberOfLines={1}>
                    {item.sharedLabel || t('sidebar.shared', 'Shared')}
                  </Text>
                </View>
              )}
              {item.sourceFolder && (
                <View style={styles.sharedBadge}>
                  <Folder size={10} color={c.mutedForeground} />
                  <Text style={styles.sharedBadgeText} numberOfLines={1}>{item.sourceFolder}</Text>
                </View>
              )}
            </View>
            {item.preview ? (
              <Text style={styles.preview} numberOfLines={1}>{singleLine(item.preview)}</Text>
            ) : null}
          </View>
        </Pressable>
      </SwipeableRow>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {selectionMode ? (
        <View style={styles.header}>
          <Pressable onPress={clearSelection} style={styles.headerBtn} hitSlop={8}>
            <X size={20} color={c.text} />
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {t('context_menu.items_selected', `${selected.size} selected`, { count: selected.size })}
          </Text>
          <Pressable onPress={() => { setStarred(selectedEmails, !allStarred); clearSelection(); }} style={styles.headerBtn} hitSlop={6}>
            <Star size={20} color={allStarred ? c.starred : c.text} fill={allStarred ? c.starred : 'transparent'} />
          </Pressable>
          <Pressable onPress={() => { setRead(selectedEmails, !allRead); clearSelection(); }} style={styles.headerBtn} hitSlop={6}>
            {allRead ? <MailIcon size={20} color={c.text} /> : <MailOpen size={20} color={c.text} />}
          </Pressable>
          {role !== 'sent' && role !== 'drafts' && (
            <Pressable onPress={() => { spam(selectedEmails); clearSelection(); }} style={styles.headerBtn} hitSlop={6}>
              {role === 'junk' ? <ShieldCheck size={20} color={c.text} /> : <ShieldAlert size={20} color={c.text} />}
            </Pressable>
          )}
          {role !== 'archive' && (
            <Pressable onPress={() => { archive(selectedEmails); clearSelection(); }} style={styles.headerBtn} hitSlop={6}>
              <Archive size={20} color={c.text} />
            </Pressable>
          )}
          <Pressable onPress={() => { void remove(selectedEmails).then(clearSelection); }} style={styles.headerBtn} hitSlop={6}>
            <Trash2 size={20} color={c.text} />
          </Pressable>
        </View>
      ) : (
        <View style={styles.header}>
          <Pressable onPress={() => navigation.goBack()} style={styles.headerBtn} hitSlop={8}>
            <ArrowLeft size={22} color={c.text} />
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
          <View style={styles.headerBtn}>
            {opening ? <ActivityIndicator size="small" color={c.primary} /> : null}
          </View>
        </View>
      )}

      <View style={styles.searchBar}>
        <Search size={16} color={c.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder={t('email_list.search_placeholder', 'Search mail...')}
          placeholderTextColor={c.textMuted}
          value={searchInput}
          onChangeText={setSearchInput}
          onSubmitEditing={() => setQuery(searchInput.trim())}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        {searchInput.length > 0 && (
          <Pressable onPress={() => { setSearchInput(''); setQuery(''); }} hitSlop={8}>
            <X size={14} color={c.textMuted} />
          </Pressable>
        )}
      </View>

      {errorCount > 0 && (
        <View style={styles.errorBanner}>
          <AlertTriangle size={14} color={c.error} />
          <Text style={styles.errorBannerText} numberOfLines={2}>
            {t('unified_mailbox.accounts_failed', `${errorCount} account(s) could not be loaded`, { count: errorCount })}
            {': '}
            {Object.values(errors)[0]}
          </Text>
        </View>
      )}

      {loading && emails.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.primary} />
          <Text style={styles.loadingText}>{t('email_list.loading', 'Loading…')}</Text>
        </View>
      ) : emails.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.loadingText}>
            {query ? t('email_list.no_search_results', 'No emails found') : t('email_list.no_emails', 'No emails')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={emails}
          keyExtractor={rowKey}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          refreshing={loading}
          onRefresh={() => { void load(); }}
          onEndReached={() => { void loadMore(); }}
          onEndReachedThreshold={0.3}
          ListFooterComponent={loadingMore ? <ActivityIndicator style={{ padding: spacing.md }} color={c.primary} /> : null}
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      )}
    </SafeAreaView>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      height: componentSizes.headerHeight,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: spacing.sm,
    },
    headerBtn: {
      width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md,
    },
    headerTitle: { ...typography.h3, color: c.text, flex: 1 },
    searchBar: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: spacing.lg,
      marginVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      height: componentSizes.inputHeight,
      backgroundColor: c.surface,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      gap: spacing.sm,
    },
    searchInput: { flex: 1, ...typography.body, color: c.text },
    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: c.errorBg,
    },
    errorBannerText: { ...typography.caption, color: c.error, flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
    loadingText: { ...typography.body, color: c.textSecondary },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },
    row: {
      flexDirection: 'row',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      backgroundColor: c.background,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    rowSelected: { backgroundColor: c.selection },
    checkbox: { width: 16, height: componentSizes.avatarMd, alignItems: 'center', justifyContent: 'center' },
    // Same unread indicator as the mailbox list (and the webmail): an 8px
    // filled circle in the start gutter (#27). Anchored on the row's *first*
    // line — top padding + half an avatar — because centring it on the row
    // drops it a full line below the avatar it reads as a column with.
    unreadDot: {
      position: 'absolute',
      left: 4,
      top: spacing.md + componentSizes.avatarMd / 2 - 4,
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.unread,
    },
    avatarWrap: { position: 'relative' },
    accountDot: {
      position: 'absolute',
      right: -2, bottom: -2,
      width: 12, height: 12,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: c.background,
    },
    content: { flex: 1, minWidth: 0, gap: 1 },
    line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    sender: { ...typography.bodyMedium, color: c.text, flex: 1 },
    bold: { fontWeight: '700' },
    time: { ...typography.caption, color: c.textMuted },
    subject: { ...typography.body, color: c.text },
    account: { ...typography.caption, color: c.textMuted },
    sharedBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: radius.full,
      backgroundColor: c.muted,
      maxWidth: 140,
    },
    sharedBadgeText: { fontSize: 10, fontWeight: '500', color: c.mutedForeground },
    preview: { ...typography.caption, color: c.textMuted },
  });
}
