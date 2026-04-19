import React from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, TextInput, Image, ActivityIndicator, Modal, TouchableOpacity, TouchableWithoutFeedback } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Search, SquarePen, Menu, Filter, Square, X, Check,
  Star, Paperclip, Mail as MailIcon,
} from 'lucide-react-native';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';
import SidebarDrawer from '../components/SidebarDrawer';
import SenderAvatar from '../components/SenderAvatar';
import { useEmailStore, type EmailFilters } from '../stores/email-store';
import type { Email } from '../api/types';

function getSenderName(email: Email): string {
  return email.from?.[0]?.name || email.from?.[0]?.email || 'Unknown';
}

function getSenderEmail(email: Email): string | undefined {
  return email.from?.[0]?.email;
}

function isUnread(email: Email): boolean {
  return !email.keywords?.$seen;
}

function isStarred(email: Email): boolean {
  return !!email.keywords?.$flagged;
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / (1000 * 60));
  const diffHr = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDay = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function EmailRow({ item, onPress }: { item: Email; onPress: () => void }) {
  const senderName = getSenderName(item);
  const senderEmail = getSenderEmail(item);
  const unread = isUnread(item);
  const starred = isStarred(item);

  return (
    <Pressable
      style={({ pressed }) => [styles.emailRow, pressed && styles.emailRowPressed]}
      onPress={onPress}
    >
      <SenderAvatar name={senderName} email={senderEmail} size={componentSizes.avatarMd} />

      {/* Content */}
      <View style={styles.emailContent}>
        {/* Row 1: Sender + indicators + time */}
        <View style={styles.emailHeaderRow}>
          <View style={styles.senderRow}>
            <Text style={[styles.emailFrom, unread && styles.textUnread]} numberOfLines={1}>
              {senderName}
            </Text>
            {starred && (
              <Star size={componentSizes.statusIcon} color={colors.starred} fill={colors.starred} />
            )}
            {item.hasAttachment && (
              <Paperclip size={componentSizes.statusIcon} color={colors.textMuted} />
            )}
          </View>
          <View style={styles.timeAndTag}>
            <Text style={styles.emailDate}>{formatRelativeTime(new Date(item.receivedAt))}</Text>
          </View>
        </View>

        {/* Row 2: Subject */}
        <View style={styles.subjectRow}>
          <Text style={[styles.emailSubject, unread && styles.textBold]} numberOfLines={1}>
            {item.subject || '(no subject)'}
          </Text>
        </View>

        {/* Row 3: Preview */}
        <Text style={styles.emailPreview} numberOfLines={2}>
          {item.preview}
        </Text>
      </View>
    </Pressable>
  );
}

interface EmailListScreenProps {
  onEmailPress?: (email: Email) => void;
  onComposePress?: () => void;
}

export default function EmailListScreen({ onEmailPress, onComposePress }: EmailListScreenProps) {
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
  const setSearchQuery = useEmailStore((s) => s.setSearchQuery);
  const setFilters = useEmailStore((s) => s.setFilters);
  const clearSearchAndFilters = useEmailStore((s) => s.clearSearchAndFilters);

  // Local input state for uninterrupted typing; debounce into the store.
  const [searchInput, setSearchInput] = React.useState(storeSearchQuery);
  React.useEffect(() => {
    // Keep local input in sync when the store is cleared externally
    // (e.g. mailbox switch resets searchQuery to '').
    if (storeSearchQuery !== searchInput && storeSearchQuery === '') {
      setSearchInput('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeSearchQuery]);
  React.useEffect(() => {
    if (searchInput === storeSearchQuery) return;
    const id = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(id);
  }, [searchInput, storeSearchQuery, setSearchQuery]);

  const activeFilterCount =
    (filters.unread ? 1 : 0) + (filters.starred ? 1 : 0) + (filters.hasAttachment ? 1 : 0);
  const hasActiveSearchOrFilter = Boolean(storeSearchQuery) || activeFilterCount > 0;

  const toggleFilter = (key: keyof EmailFilters) => {
    setFilters({ ...filters, [key]: !filters[key] });
  };

  const currentMailbox = React.useMemo(
    () => mailboxes.find((m) => m.id === currentMailboxId),
    [mailboxes, currentMailboxId],
  );

  // Load mailboxes and select inbox on mount
  React.useEffect(() => {
    if (mailboxes.length === 0) {
      void fetchMailboxes();
    }
  }, [fetchMailboxes, mailboxes.length]);

  React.useEffect(() => {
    if (mailboxes.length > 0 && !currentMailboxId) {
      const inbox = mailboxes.find((m) => m.role === 'inbox') || mailboxes[0];
      void selectMailbox(inbox.id);
    }
  }, [mailboxes, currentMailboxId, selectMailbox]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => setDrawerOpen(true)} style={styles.headerButton}>
          <Menu size={20} color={colors.textMuted} />
        </Pressable>
        <Text style={styles.headerTitle}>{currentMailbox?.name ?? 'Inbox'}</Text>
        <View style={{ flex: 1 }} />
        <Image
          source={require('../../assets/logos/Bulwark Logo White.png')}
          style={styles.headerLogo}
          resizeMode="contain"
        />
      </View>

      {/* Search bar (always visible) */}
      <View style={styles.searchBar}>
        <Pressable style={styles.checkboxButton}>
          <Square size={18} color={colors.textMuted} />
        </Pressable>
        <View style={styles.searchInputArea}>
          <Search size={16} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search mail..."
            placeholderTextColor={colors.textMuted}
            value={searchInput}
            onChangeText={setSearchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {searchInput.length > 0 && (
            <Pressable
              onPress={() => setSearchInput('')}
              hitSlop={8}
              style={styles.searchClearButton}
            >
              <X size={14} color={colors.textMuted} />
            </Pressable>
          )}
        </View>
        <Pressable
          style={[styles.filterButton, activeFilterCount > 0 && styles.filterButtonActive]}
          onPress={() => setFilterMenuOpen(true)}
        >
          <Filter size={18} color={activeFilterCount > 0 ? colors.primary : colors.textMuted} />
          {activeFilterCount > 0 && (
            <View style={styles.filterBadge}>
              <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
            </View>
          )}
        </Pressable>
      </View>

      {hasActiveSearchOrFilter && (
        <View style={styles.filterChipsRow}>
          {storeSearchQuery ? (
            <View style={styles.chip}>
              <Search size={12} color={colors.textSecondary} />
              <Text style={styles.chipText} numberOfLines={1}>
                {storeSearchQuery}
              </Text>
            </View>
          ) : null}
          {filters.unread && (
            <View style={styles.chip}>
              <MailIcon size={12} color={colors.textSecondary} />
              <Text style={styles.chipText}>Unread</Text>
            </View>
          )}
          {filters.starred && (
            <View style={styles.chip}>
              <Star size={12} color={colors.starred} fill={colors.starred} />
              <Text style={styles.chipText}>Starred</Text>
            </View>
          )}
          {filters.hasAttachment && (
            <View style={styles.chip}>
              <Paperclip size={12} color={colors.textSecondary} />
              <Text style={styles.chipText}>Has attachment</Text>
            </View>
          )}
          <Pressable
            onPress={() => {
              setSearchInput('');
              clearSearchAndFilters();
            }}
            style={styles.clearAllButton}
            hitSlop={6}
          >
            <Text style={styles.clearAllText}>Clear</Text>
          </Pressable>
        </View>
      )}

      {/* Email list */}
      {loading && emails.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.loadingText}>Loading emails...</Text>
        </View>
      ) : error ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => { void refreshEmails(); }}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : mailboxes.length === 0 ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>No mailboxes found</Text>
          <Text style={styles.hintText}>
            Check that your JMAP account has mail capability.
          </Text>
        </View>
      ) : emails.length === 0 ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>
            No emails in {currentMailbox?.name ?? 'this folder'}
          </Text>
          {currentMailbox ? (
            <Text style={styles.hintText}>
              {currentMailbox.totalEmails} total · {currentMailbox.unreadEmails} unread
            </Text>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={emails}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <EmailRow item={item} onPress={() => onEmailPress?.(item)} />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listContent}
          onEndReached={() => { void loadMoreEmails(); }}
          onEndReachedThreshold={0.3}
          refreshing={loading}
          onRefresh={() => { void refreshEmails(); }}
        />
      )}

      {/* Compose FAB — matches webmail mobile: PenSquare, h-14 w-14, rounded-full, shadow-lg */}
      <Pressable
        onPress={onComposePress}
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
      >
        <SquarePen size={24} color={colors.background} />
      </Pressable>

      <SidebarDrawer visible={drawerOpen} onClose={() => setDrawerOpen(false)} />

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
                <Text style={styles.filterMenuTitle}>Filter emails</Text>
                <FilterToggle
                  label="Unread"
                  icon={<MailIcon size={16} color={colors.textSecondary} />}
                  active={!!filters.unread}
                  onPress={() => toggleFilter('unread')}
                />
                <FilterToggle
                  label="Starred"
                  icon={<Star size={16} color={colors.starred} fill={filters.starred ? colors.starred : 'transparent'} />}
                  active={!!filters.starred}
                  onPress={() => toggleFilter('starred')}
                />
                <FilterToggle
                  label="Has attachment"
                  icon={<Paperclip size={16} color={colors.textSecondary} />}
                  active={!!filters.hasAttachment}
                  onPress={() => toggleFilter('hasAttachment')}
                />
                {activeFilterCount > 0 && (
                  <TouchableOpacity
                    style={styles.filterClearRow}
                    onPress={() => setFilters({})}
                  >
                    <Text style={styles.filterClearText}>Clear filters</Text>
                  </TouchableOpacity>
                )}
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </SafeAreaView>
  );
}

function FilterToggle({
  label, icon, active, onPress,
}: { label: string; icon: React.ReactNode; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.filterToggle, pressed && styles.filterTogglePressed]}
      onPress={onPress}
    >
      <View style={styles.filterToggleLeft}>
        {icon}
        <Text style={styles.filterToggleLabel}>{label}</Text>
      </View>
      <View style={[styles.filterCheck, active && styles.filterCheckActive]}>
        {active && <Check size={14} color={colors.background} />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  // Header — matches web mobile-header: h-14 (56px), px-4, border-b
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    height: componentSizes.headerHeight,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  headerButton: {
    width: componentSizes.buttonLg, height: componentSizes.buttonLg, // h-11 w-11 = 44px
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.full,
  },
  headerTitle: { ...typography.h3, color: colors.text, flex: 1 }, // text-lg font-semibold
  headerLogo: {
    width: 28,
    height: 28,
  },

  // Search — matches web search bar styling
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
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  searchInput: { flex: 1, ...typography.body, color: colors.text },
  filterButton: {
    width: componentSizes.buttonMd, height: componentSizes.buttonMd,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.xs,
    position: 'relative',
  },
  filterButtonActive: {
    backgroundColor: colors.accent,
  },
  filterBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  filterBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.primaryForeground,
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
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    maxWidth: 200,
  },
  chipText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  clearAllButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  clearAllText: {
    ...typography.captionMedium,
    color: colors.primary,
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
    maxWidth: 360,
    backgroundColor: colors.popover,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
  },
  filterMenuTitle: {
    ...typography.bodySemibold,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  filterToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  filterTogglePressed: {
    backgroundColor: colors.surfaceHover,
  },
  filterToggleLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
  },
  filterToggleLabel: {
    ...typography.body,
    color: colors.text,
  },
  filterCheck: {
    width: 20,
    height: 20,
    borderRadius: radius.xs,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterCheckActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  filterClearRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.xs,
  },
  filterClearText: {
    ...typography.bodyMedium,
    color: colors.error,
  },

  // Email list — matches web email-list-item
  listContent: { paddingBottom: 100 },
  emailRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,      // px-4 = 16px
    paddingVertical: spacing.md,        // py-3 = 12px (density-item-py)
    gap: spacing.md,                    // gap-3 = 12px (density-item-gap)
    borderBottomWidth: 1,
    borderBottomColor: colors.border,   // border-b border-border
  },
  emailRowPressed: { backgroundColor: colors.surface },
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
  emailFrom: { ...typography.bodyMedium, color: colors.textSecondary, flexShrink: 1 },
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
  threadBadgeText: { ...typography.caption, color: colors.textMuted },
  // Date: text-xs (12px), tabular-nums
  emailDate: { ...typography.caption, color: colors.textMuted },
  subjectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  // Subject: text-sm (14px), font-semibold (unread) / font-normal (read)
  emailSubject: { ...typography.body, color: colors.text, flex: 1 },
  // Preview: text-sm, leading-relaxed, line-clamp-2
  emailPreview: { ...typography.body, color: colors.textSecondary, lineHeight: 20, opacity: 0.8 },
  // Unread state: text foreground + font-bold
  textUnread: { fontWeight: '600', color: colors.text },
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

  // Compose FAB — matches webmail: absolute bottom-4 right-4, h-14 w-14, rounded-full, bg-primary, shadow-lg
  fab: {
    position: 'absolute',
    right: spacing.lg,               // right-4
    bottom: spacing.lg,              // bottom-4
    width: componentSizes.fab,       // 56px (h-14)
    height: componentSizes.fab,      // 56px (w-14)
    borderRadius: radius.full,       // rounded-full (circle)
    backgroundColor: colors.text,    // white — matches webmail mobile FAB
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
    color: colors.textMuted,
  },
  errorText: {
    ...typography.body,
    color: colors.error,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  retryText: {
    ...typography.bodyMedium,
    color: colors.primary,
    marginTop: spacing.sm,
  },
  hintText: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: spacing.xs,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
});

export type { EmailListScreenProps };
