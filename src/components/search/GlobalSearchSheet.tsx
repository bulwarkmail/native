import React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AlertTriangle, ArrowLeft, CalendarDays, Clock, FileText, Folder, Repeat, Search, X } from '../icons';
import SenderAvatar from '../SenderAvatar';
import { SafeAreaModal } from '../SafeAreaModal';
import { SearchSnippetText } from '../email/SearchSnippetText';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useAccountStore } from '../../stores/account-store';
import { useSearchHistoryStore } from '../../stores/search-history-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { GLOBAL_SEARCH_PROVIDERS, getSearchAccounts } from '../../api/global-search';
import { SEARCH_KINDS, type SearchKind, type SearchScope } from '../../lib/global-search/query-parser';
import { useGlobalSearch } from '../../lib/global-search/use-global-search';
import { openHit, type HitNavigation } from '../../lib/global-search/open-hit';
import type { GlobalSearchHit } from '../../lib/global-search/types';
import { getContactDisplayName, getContactPrimaryEmail } from '../../lib/contact-utils';

export const SHEET_LOCAL_LIMIT = 10;
export const SHEET_REMOTE_LIMIT = 25;
/** Rows per kind before "Show all results" (the webmail palette shows five). */
export const ROWS_PER_KIND = 5;

/** The rows a kind shows: the first five, or all once its "Show all" was tapped. */
export function visibleHits(hits: GlobalSearchHit[], expanded: boolean): GlobalSearchHit[] {
  return expanded ? hits : hits.slice(0, ROWS_PER_KIND);
}

interface GlobalSearchSheetProps {
  visible: boolean;
  /** What the search starts with (the mail search field's text). */
  initialQuery?: string;
  onClose: () => void;
  navigation: HitNavigation;
}

function formatHitDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  try {
    return new Intl.DateTimeFormat(locale, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  } catch {
    return date.toDateString();
  }
}

/**
 * "Search everything" (webmail components/global-search/global-search-palette.tsx):
 * one query across mail, contacts, calendar events and files of every
 * signed-in account. What is already loaded shows while typing; the
 * servers' answers merge in per kind as each account answers. A tap opens
 * the hit in its own account.
 */
export function GlobalSearchSheet({ visible, initialQuery = '', onClose, navigation }: GlobalSearchSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const accounts = useAccountStore((s) => s.accounts);
  const recentSearches = useSearchHistoryStore((s) => s.recentSearches);
  const addRecentSearch = useSearchHistoryStore((s) => s.addRecentSearch);

  const [query, setQuery] = React.useState(initialQuery);
  const [scope, setScope] = React.useState<SearchScope>('all');
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<SearchKind>>(() => new Set());
  const pending = React.useRef<GlobalSearchHit | null>(null);

  React.useEffect(() => {
    if (!visible) return;
    setQuery(initialQuery);
    setExpanded(new Set());
  }, [visible, initialQuery]);
  React.useEffect(() => { setExpanded(new Set()); }, [query, scope, accountId]);

  const { parsed, outcome, isSearching } = useGlobalSearch({
    query, scope, accountId,
    localLimit: SHEET_LOCAL_LIMIT,
    remoteLimit: SHEET_REMOTE_LIMIT,
    enabled: visible,
    providers: GLOBAL_SEARCH_PROVIDERS,
    accounts: getSearchAccounts,
  });

  const trimmed = query.trim();
  const kinds = SEARCH_KINDS.filter((kind) => parsed.scope === 'all' || parsed.scope === kind);
  const hasAnyHit = kinds.some((kind) => outcome.hits[kind].length > 0);
  const allHits = kinds.flatMap((kind) => outcome.hits[kind]);
  const errors = trimmed ? kinds.flatMap((kind) => outcome.status[kind].errors) : [];
  const showRecent = !trimmed && recentSearches.length > 0;

  const open = (hit: GlobalSearchHit) => {
    if (trimmed) addRecentSearch(trimmed);
    // iOS presents the next screen only once this modal is gone.
    if (Platform.OS === 'ios') {
      pending.current = hit;
      onClose();
      return;
    }
    onClose();
    void openHit(hit, navigation, allHits);
  };

  const scopes: { key: SearchScope; label: string }[] = [
    { key: 'all', label: t('global_search.scope_all', 'All') },
    { key: 'mail', label: t('global_search.scope_mail', 'Mail') },
    { key: 'contacts', label: t('global_search.scope_contacts', 'Contacts') },
    { key: 'calendar', label: t('global_search.scope_calendar', 'Calendar') },
    { key: 'files', label: t('global_search.scope_files', 'Files') },
  ];
  const kindLabel = (kind: SearchKind) => scopes.find((s) => s.key === kind)?.label ?? kind;

  const renderLeading = (hit: GlobalSearchHit) => {
    if (hit.kind === 'mail') {
      const from = hit.email.from?.[0];
      return <SenderAvatar name={from?.name} email={from?.email} size={28} />;
    }
    if (hit.kind === 'contacts') {
      return <SenderAvatar name={getContactDisplayName(hit.contact) || undefined} email={getContactPrimaryEmail(hit.contact) || undefined} size={28} />;
    }
    const Icon = hit.kind === 'calendar' ? CalendarDays : hit.isFolder ? Folder : FileText;
    return (
      <View style={styles.iconChip}>
        <Icon size={14} color={c.textSecondary} />
      </View>
    );
  };

  const renderRow = (hit: GlobalSearchHit) => {
    const title = hit.title || (hit.kind === 'mail' ? t('global_search.no_subject', '(no subject)') : hit.id);
    const subtitle = [hit.accountLabel, hit.subtitle].filter(Boolean).join(' · ');
    const snippet = hit.kind === 'mail' && hit.snippet?.preview ? hit.snippet.preview : null;
    return (
      <Pressable
        key={`${hit.kind}:${hit.localAccountId}:${hit.jmapAccountId}:${hit.id}`}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => open(hit)}
        accessibilityRole="button"
        accessibilityLabel={[title, subtitle].filter(Boolean).join(', ')}
      >
        {renderLeading(hit)}
        <View style={styles.rowText}>
          <View style={styles.rowTitleLine}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {hit.kind === 'mail' && hit.snippet?.subject ? <SearchSnippetText snippet={hit.snippet.subject} /> : title}
            </Text>
            {hit.kind === 'calendar' && hit.isRecurring ? (
              <View accessible accessibilityLabel={t('global_search.recurring', 'Recurring')}>
                <Repeat size={12} color={c.textMuted} />
              </View>
            ) : null}
            {hit.date ? <Text style={styles.rowDate}>{formatHitDate(hit.date, locale)}</Text> : null}
          </View>
          {subtitle ? <Text style={styles.rowSub} numberOfLines={1}>{subtitle}</Text> : null}
          {snippet ? <Text style={styles.rowSub} numberOfLines={1}><SearchSnippetText snippet={snippet} /></Text> : null}
        </View>
      </Pressable>
    );
  };

  const renderGroup = (kind: SearchKind) => {
    const hits = outcome.hits[kind];
    const status = outcome.status[kind];
    if (hits.length === 0 && status.status !== 'loading') return null;
    const isExpanded = expanded.has(kind);
    return (
      <View key={kind} style={styles.group} accessibilityRole="list" accessibilityLabel={kindLabel(kind)}>
        <View style={styles.groupHeader}>
          <Text style={styles.groupTitle}>{kindLabel(kind)}</Text>
          <View style={styles.countPill}><Text style={styles.countText}>{hits.length}</Text></View>
          {status.status === 'loading' ? <ActivityIndicator size="small" color={c.textMuted} /> : null}
        </View>
        {visibleHits(hits, isExpanded).map(renderRow)}
        {!isExpanded && hits.length > ROWS_PER_KIND ? (
          <Pressable
            style={({ pressed }) => [styles.showAll, pressed && styles.rowPressed]}
            onPress={() => setExpanded((prev) => new Set(prev).add(kind))}
            accessibilityRole="button"
          >
            <Text style={styles.showAllText}>{t('global_search.show_all', 'Show all results')}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  const chip = (key: string, label: string, selected: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipActive]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text style={[styles.chipText, selected && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );

  return (
    <SafeAreaModal
      supportedOrientations={MODAL_ORIENTATIONS}
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
      onDismiss={() => {
        const hit = pending.current;
        pending.current = null;
        if (hit) void openHit(hit, navigation, allHits);
      }}
    >
      <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={8} style={styles.headerBtn} accessibilityRole="button" accessibilityLabel={t('common.close', 'Close')}>
            <ArrowLeft size={20} color={c.text} />
          </Pressable>
          <View style={styles.field}>
            <Search size={16} color={c.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('global_search.placeholder', 'Search mail, contacts, calendar, files...')}
              placeholderTextColor={c.mutedForeground}
              style={styles.input}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => { if (trimmed) addRecentSearch(trimmed); }}
              accessibilityLabel={t('global_search.title', 'Search everything')}
            />
            {isSearching ? <ActivityIndicator size="small" color={c.textMuted} /> : null}
            {query ? (
              <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('contacts.clear_search', 'Clear search')}>
                <X size={16} color={c.textMuted} />
              </Pressable>
            ) : null}
          </View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
          {scopes.map((s) => chip(s.key, s.label, scope === s.key, () => setScope(s.key)))}
          {accounts.length > 1 ? (
            <>
              <View style={styles.chipDivider} />
              {chip('all-accounts', t('global_search.all_accounts', 'All accounts'), accountId === null, () => setAccountId(null))}
              {accounts.map((a) => chip(a.id, a.displayName || a.email || a.username, accountId === a.id, () => setAccountId(a.id)))}
            </>
          ) : null}
        </ScrollView>

        <ScrollView style={styles.results} keyboardShouldPersistTaps="handled">
          {showRecent ? (
            <View style={styles.group}>
              <View style={styles.groupHeader}>
                <Text style={styles.groupTitle}>{t('global_search.recent_searches', 'Recent searches')}</Text>
              </View>
              {recentSearches.map((term) => (
                <Pressable key={term} style={({ pressed }) => [styles.recentRow, pressed && styles.rowPressed]} onPress={() => setQuery(term)} accessibilityRole="button">
                  <Clock size={14} color={c.textMuted} />
                  <Text style={styles.recentText} numberOfLines={1}>{term}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {trimmed ? kinds.map(renderGroup) : null}
          {errors.map((error) => (
            <View key={`${error.localAccountId}:${error.message}`} style={styles.errorRow}>
              <AlertTriangle size={14} color={c.warning} />
              <Text style={styles.rowSub}>{t('global_search.account_error', "Couldn't search {account}", { account: error.accountLabel })}</Text>
            </View>
          ))}
          {!trimmed && !showRecent ? (
            <Text style={styles.hint}>
              {t('global_search.empty_hint', 'Search mail, contacts, events and files across all accounts. Try from:, subject:, has:attachment, after:2026-01-01.')}
            </Text>
          ) : null}
          {trimmed && !hasAnyHit && !isSearching ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{t('global_search.no_results', 'No results for “{query}”', { query: trimmed })}</Text>
              <Text style={styles.hint}>{t('global_search.server_hint', 'Complete words search the server; partial words match already-loaded items')}</Text>
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaModal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
      paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
      borderBottomWidth: 1, borderBottomColor: c.border,
    },
    headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
    field: {
      flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
      paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: c.surface,
      borderWidth: 1, borderColor: c.border,
    },
    input: { flex: 1, ...typography.body, color: c.text, paddingVertical: spacing.sm },
    chips: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    chip: {
      paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.full,
      borderWidth: 1, borderColor: c.border, backgroundColor: c.surface,
    },
    chipActive: { backgroundColor: c.primary, borderColor: c.primary },
    chipText: { ...typography.caption, color: c.text },
    chipTextActive: { color: c.primaryForeground },
    chipDivider: { width: 1, height: 20, backgroundColor: c.border, marginHorizontal: spacing.xs },
    results: { flex: 1 },
    group: { paddingVertical: spacing.xs },
    groupHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xs },
    groupTitle: { ...typography.captionMedium, color: c.textSecondary },
    countPill: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: c.muted },
    countText: { fontSize: 10, fontWeight: '600', color: c.textSecondary },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, minHeight: 48 },
    rowPressed: { backgroundColor: c.surfaceHover },
    rowText: { flex: 1, minWidth: 0 },
    rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    rowTitle: { ...typography.bodyMedium, color: c.text, flex: 1 },
    rowDate: { ...typography.caption, color: c.textMuted },
    rowSub: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    iconChip: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: c.muted },
    showAll: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    showAllText: { ...typography.caption, color: c.primary },
    recentRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, minHeight: 44 },
    recentText: { ...typography.body, color: c.text, flex: 1 },
    errorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs },
    hint: { ...typography.caption, color: c.textMuted, textAlign: 'center', padding: spacing.lg },
    empty: { paddingVertical: spacing.lg },
    emptyTitle: { ...typography.body, color: c.text, textAlign: 'center' },
  });
}
