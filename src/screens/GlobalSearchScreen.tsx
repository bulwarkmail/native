import React from 'react';
import {
  ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  AlertTriangle, ArrowLeft, CalendarDays, Clock, FileText, Folder, Repeat, Search, User, X,
} from 'lucide-react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import SenderAvatar from '../components/SenderAvatar';
import { GLOBAL_SEARCH_PROVIDERS } from '../lib/global-search/providers';
import { openHit, type OpenHitNavigation } from '../lib/global-search/open-hit';
import { useGlobalSearchStore } from '../lib/global-search/store';
import type { SearchScope } from '../lib/global-search/query-parser';
import type { GlobalSearchHit, SearchKind } from '../lib/global-search/types';
import { useGlobalSearch } from '../lib/global-search/use-global-search';
import { searchAccountsFrom, searchRows, showNoResults, type SearchRow } from '../lib/global-search/view-model';
import { useServedAccount } from '../lib/served-account';
import { useAccountStore } from '../stores/account-store';
import { useLocaleStore } from '../stores/locale-store';
import { useSearchHistoryStore } from '../stores/search-history-store';
import { useToastStore } from '../stores/toast-store';
import { spacing, typography, componentSizes, radius, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

type Props = NativeStackScreenProps<RootStackParamList, 'GlobalSearch'>;

// Webmail's palette sizes (global-search-palette.tsx): a few cache hits per
// keystroke, a page from each server; "Load more" grows the mail page.
const LOCAL_LIMIT = 10;
const REMOTE_LIMIT = 25;

const SCOPES: readonly SearchScope[] = ['all', 'mail', 'contacts', 'calendar', 'files'];

const SCOPE_FALLBACK: Record<SearchScope, string> = {
  all: 'All',
  mail: 'Mail',
  contacts: 'Contacts',
  calendar: 'Calendar',
  files: 'Files',
};

function formatHitDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  try {
    return new Intl.DateTimeFormat(locale, sameYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  } catch {
    return date.toDateString();
  }
}

/**
 * "Search everything" (webmail #641): one query across mail of every signed-in
 * account and the shown account's contacts, events and files. Cache hits
 * show per keystroke, server hits merge in per kind after a 300 ms pause.
 * A tapped hit opens in its own account, switching to it first.
 */
export default function GlobalSearchScreen({ navigation, route }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);

  const [query, setQuery] = React.useState(route.params?.query ?? '');
  // Opened again from the mail search bar with another query.
  const paramQuery = route.params?.query;
  React.useEffect(() => {
    if (paramQuery !== undefined) setQuery(paramQuery);
  }, [paramQuery]);
  const scope = useGlobalSearchStore((s) => s.scope);
  const setScope = useGlobalSearchStore((s) => s.setScope);
  const [expanded, setExpanded] = React.useState<ReadonlySet<SearchKind>>(new Set());

  const recentSearches = useSearchHistoryStore((s) => s.recentSearches);
  const addRecentSearch = useSearchHistoryStore((s) => s.addRecentSearch);
  const removeRecentSearch = useSearchHistoryStore((s) => s.removeRecentSearch);

  const accountEntries = useAccountStore((s) => s.accounts);
  const accounts = React.useMemo(() => searchAccountsFrom(accountEntries), [accountEntries]);
  // Contacts, calendar and files search the shown account once it is
  // served: re-run when it changes, as for a signed-in or out account.
  const served = useServedAccount();
  const accountsKey = React.useMemo(
    () => JSON.stringify([accounts.map((a) => [a.appAccountId, a.serverUrl]), served.appAccountId, served.jmapAccountId]),
    [accounts, served],
  );

  const { outcome, parsed, isSearching, isEmpty, loadMoreMail } = useGlobalSearch({
    query,
    scope,
    accountId: null,
    providers: GLOBAL_SEARCH_PROVIDERS,
    accounts,
    accountsKey,
    localLimit: LOCAL_LIMIT,
    remoteLimit: REMOTE_LIMIT,
  });

  // A new search starts with every group collapsed.
  React.useEffect(() => setExpanded(new Set()), [query, scope]);

  const trimmed = query.trim();
  const rows = React.useMemo(
    () => (trimmed ? searchRows(outcome, parsed.scope, expanded) : []),
    [trimmed, outcome, parsed.scope, expanded],
  );
  const noResults = !!trimmed && showNoResults(outcome, parsed.scope, { isSearching, isEmpty });

  // One open at a time: a second tap while a switch runs is dropped.
  const opening = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);

  const onOpenHit = React.useCallback((hit: GlobalSearchHit) => {
    if (opening.current) return;
    opening.current = true;
    if (trimmed) addRecentSearch(trimmed);
    // Backed out while the switch ran: openHit checks `active` and opens
    // (or parks) nothing.
    const nav: OpenHitNavigation = {
      openThread: (params) => navigation.navigate('EmailThread', params),
      openContact: (contactId) => navigation.navigate('ContactDetail', { contactId }),
      openTab: (tab) => navigation.navigate('MainTabs', { screen: tab } as never),
      active: () => mounted.current,
    };
    // openHit resolves with its outcome and never rejects; the catch only
    // keeps a failing toast from becoming an unhandled rejection.
    void openHit(hit, nav)
      .then((result) => {
        if (!result.opened && result.message && mounted.current) {
          useToastStore.getState().addToast({ type: 'error', title: result.message });
        }
      })
      .catch((err) => console.warn('[global-search] open failed', err))
      .finally(() => { opening.current = false; });
  }, [addRecentSearch, navigation, trimmed]);

  const scopeLabel = (s: SearchScope) => t(`global_search.scope_${s}`, SCOPE_FALLBACK[s]);

  const renderHit = (hit: GlobalSearchHit) => {
    const title = hit.title || (hit.kind === 'mail' ? t('global_search.no_subject', '(no subject)') : hit.id);
    const subtitle = [hit.accountLabel, hit.subtitle].filter(Boolean).join(' · ');
    let leading: React.ReactNode;
    if (hit.kind === 'mail') {
      const from = hit.email.from?.[0];
      leading = <SenderAvatar name={from?.name} email={from?.email} size={28} />;
    } else if (hit.kind === 'contacts') {
      leading = <View style={styles.iconChip}><User size={14} color={c.primary} /></View>;
    } else if (hit.kind === 'calendar') {
      leading = <View style={styles.iconChip}><CalendarDays size={14} color={c.primary} /></View>;
    } else {
      leading = (
        <View style={styles.iconChip}>
          {hit.isFolder ? <Folder size={14} color={c.warning} /> : <FileText size={14} color={c.warning} />}
        </View>
      );
    }
    const date = hit.date ? formatHitDate(hit.date, locale) : '';
    return (
      <Pressable
        style={({ pressed }) => [styles.hitRow, pressed && styles.pressed]}
        onPress={() => onOpenHit(hit)}
        accessibilityRole="button"
        accessibilityLabel={[title, subtitle, date].filter(Boolean).join(', ')}
      >
        {leading}
        <View style={styles.hitText}>
          <View style={styles.hitTitleLine}>
            <Text style={styles.hitTitle} numberOfLines={1}>{title}</Text>
            {hit.kind === 'calendar' && hit.isRecurring ? (
              <Repeat size={12} color={c.textMuted} accessibilityLabel={t('global_search.recurring', 'Recurring')} />
            ) : null}
            {date ? <Text style={styles.hitDate}>{date}</Text> : null}
          </View>
          {subtitle ? <Text style={styles.hitSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
      </Pressable>
    );
  };

  const renderRow = ({ item }: { item: SearchRow }) => {
    switch (item.type) {
      case 'header':
        return (
          <View style={styles.groupHeader} accessibilityRole="header">
            <Text style={styles.groupTitle}>{scopeLabel(item.kind)}</Text>
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{item.count}{item.hasMore ? '+' : ''}</Text>
            </View>
            {item.loading ? (
              <ActivityIndicator size="small" color={c.textMuted} accessibilityLabel={t('global_search.searching', 'Searching...')} />
            ) : null}
          </View>
        );
      case 'hit':
        return renderHit(item.hit);
      case 'show_all':
        return (
          <Pressable
            style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
            onPress={() => setExpanded((prev) => new Set(prev).add(item.kind))}
            accessibilityRole="button"
          >
            <Text style={styles.linkText}>{t('global_search.show_all', 'Show all results')} ({item.hidden})</Text>
          </Pressable>
        );
      case 'error':
        return (
          <View style={styles.errorRow}>
            <AlertTriangle size={14} color={c.warning} />
            <Text style={styles.errorText}>
              {t('global_search.account_error', "Couldn't search {account}", { account: item.accountLabel })}
            </Text>
          </View>
        );
      case 'load_more':
        return (
          <Pressable
            style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
            onPress={loadMoreMail}
            accessibilityRole="button"
          >
            <Text style={styles.linkText}>{t('global_search.load_more', 'Load more')}</Text>
          </Pressable>
        );
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => navigation.goBack()}
          style={styles.headerBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
        >
          <ArrowLeft size={22} color={c.text} />
        </Pressable>
        <View style={styles.inputArea}>
          <Search size={16} color={c.textMuted} />
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => { if (trimmed) addRecentSearch(trimmed); }}
            placeholder={t('global_search.placeholder', 'Search mail, contacts, calendar, files...')}
            placeholderTextColor={c.textMuted}
            accessibilityLabel={t('global_search.title', 'Search everything')}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {isSearching ? (
            <ActivityIndicator size="small" color={c.textMuted} accessibilityLabel={t('global_search.searching', 'Searching...')} />
          ) : null}
          {query.length > 0 ? (
            <Pressable
              onPress={() => setQuery('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('contacts.clear_search', 'Clear search')}
            >
              <X size={14} color={c.textMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipsScroll}
        contentContainerStyle={styles.chips}
        accessibilityRole="radiogroup"
        accessibilityLabel={t('global_search.scope_label', 'Search in')}
      >
        {SCOPES.map((option) => {
          const selected = scope === option;
          return (
            <Pressable
              key={option}
              onPress={() => setScope(option)}
              style={[styles.chip, selected && styles.chipSelected]}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{scopeLabel(option)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {!trimmed ? (
        recentSearches.length > 0 ? (
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.listContent}>
            <Text style={styles.sectionTitle}>{t('global_search.recent_searches', 'Recent searches')}</Text>
            {recentSearches.map((term) => (
              <View key={term} style={styles.recentRow}>
                <Pressable style={styles.recentMain} onPress={() => setQuery(term)} accessibilityRole="button">
                  <Clock size={14} color={c.textMuted} />
                  <Text style={styles.recentText} numberOfLines={1}>{term}</Text>
                </Pressable>
                <Pressable
                  onPress={() => removeRecentSearch(term)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('advanced_search.suggestions_remove_recent', 'Remove from recent searches')}
                >
                  <X size={14} color={c.textMuted} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : (
          <Text style={styles.hint}>
            {t('global_search.empty_hint', 'Search mail, contacts, events and files across all accounts. Try from:, subject:, has:attachment, after:2026-01-01.')}
          </Text>
        )
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={renderRow}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.listContent}
          ListFooterComponent={noResults ? (
            <View style={styles.noResults}>
              <Text style={styles.noResultsText}>
                {t('global_search.no_results', 'No results for “{query}”', { query: trimmed })}
              </Text>
              <Text style={styles.hint}>
                {t('global_search.server_hint', 'Complete words search the server; partial words match already-loaded items')}
              </Text>
            </View>
          ) : null}
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
      paddingHorizontal: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: spacing.sm,
    },
    headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    inputArea: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      height: 38,
      borderRadius: radius.md,
      backgroundColor: c.surface,
    },
    input: { ...typography.body, flex: 1, color: c.text, paddingVertical: 0 },
    chipsScroll: { flexGrow: 0 },
    chips: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.xs },
    chip: {
      paddingHorizontal: spacing.md,
      minHeight: 32,
      justifyContent: 'center',
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: c.border,
    },
    chipSelected: { backgroundColor: c.primaryBg, borderColor: c.primaryBorder },
    chipText: { ...typography.caption, color: c.textSecondary },
    chipTextSelected: { color: c.primary, fontWeight: '600' },
    listContent: { paddingBottom: spacing.xxl },
    sectionTitle: {
      ...typography.caption,
      color: c.textMuted,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.xs,
    },
    recentRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, minHeight: 44, gap: spacing.sm },
    recentMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
    recentText: { ...typography.body, color: c.text, flexShrink: 1 },
    hint: { ...typography.caption, color: c.textMuted, textAlign: 'center', padding: spacing.lg },
    groupHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.xs,
    },
    groupTitle: { ...typography.captionMedium, color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
    countBadge: {
      minWidth: 20,
      height: 18,
      paddingHorizontal: 6,
      borderRadius: radius.full,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    countText: { ...typography.small, color: c.textSecondary, fontWeight: '600' },
    hitRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      minHeight: 52,
    },
    pressed: { backgroundColor: c.surfaceHover },
    iconChip: {
      width: 28,
      height: 28,
      borderRadius: radius.full,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    hitText: { flex: 1, minWidth: 0 },
    hitTitleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    hitTitle: { ...typography.bodyMedium, color: c.text, flexShrink: 1 },
    hitDate: { ...typography.caption, color: c.textMuted, marginLeft: 'auto' },
    hitSubtitle: { ...typography.caption, color: c.textSecondary },
    linkRow: { paddingHorizontal: spacing.lg, minHeight: 40, justifyContent: 'center' },
    linkText: { ...typography.bodyMedium, color: c.primary },
    errorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
    errorText: { ...typography.caption, color: c.textSecondary, flex: 1 },
    noResults: { alignItems: 'center', paddingTop: spacing.xxl, paddingHorizontal: spacing.lg },
    noResultsText: { ...typography.body, color: c.text, textAlign: 'center' },
  });
}
