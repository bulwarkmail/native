import React from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, TextInput, Image, ActivityIndicator, Modal, Platform, ScrollView, TouchableWithoutFeedback } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import {
  Search, SquarePen, Menu, Filter, Square, SquareCheck, Minus, X,
  Star, Paperclip, Mail as MailIcon, MailOpen, Trash2, RotateCcw, CalendarDays,
} from 'lucide-react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import SidebarDrawer from '../components/SidebarDrawer';
import SenderAvatar from '../components/SenderAvatar';
import { SwipeableRow } from '../components/SwipeableRow';
import { MoveSheet } from '../components/MoveSheet';
import { UndoSnackbar } from '../components/UndoSnackbar';
import { OfflineBanner } from '../components/OfflineBanner';
import { useNetworkStore } from '../stores/network-store';
import { useEmailStore, type EmailFilters } from '../stores/email-store';
import { useSettingsStore, type SwipeAction } from '../stores/settings-store';
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

function isPinned(email: Email): boolean {
  return !!email.keywords?.$important;
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

const EmailRow = React.memo(function EmailRow({
  item,
  onPress,
  onLongPress,
  selected,
  selectionMode,
}: {
  item: Email;
  onPress: (id: string) => void;
  onLongPress: (id: string) => void;
  selected: boolean;
  selectionMode: boolean;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const senderName = getSenderName(item);
  const senderEmail = getSenderEmail(item);
  const unread = isUnread(item);
  const starred = isStarred(item);

  const handlePress = React.useCallback(() => onPress(item.id), [onPress, item.id]);
  const handleLongPress = React.useCallback(() => onLongPress(item.id), [onLongPress, item.id]);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.emailRow,
        pressed && styles.emailRowPressed,
        selected && styles.emailRowSelected,
      ]}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={300}
    >
      {selectionMode && (
        <View style={styles.rowCheckboxWrap}>
          {selected ? (
            <SquareCheck size={16} color={c.primary} />
          ) : (
            <Square size={16} color={c.textMuted} />
          )}
        </View>
      )}
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
              <Star size={componentSizes.statusIcon} color={c.starred} fill={c.starred} />
            )}
            {item.hasAttachment && (
              <Paperclip size={componentSizes.statusIcon} color={c.textMuted} />
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
  const markRead = useEmailStore((s) => s.markRead);
  const markUnread = useEmailStore((s) => s.markUnread);
  const toggleStar = useEmailStore((s) => s.toggleStar);
  const togglePin = useEmailStore((s) => s.togglePin);
  const deleteEmailAction = useEmailStore((s) => s.deleteEmail);
  const moveToMailboxAction = useEmailStore((s) => s.moveToMailbox);
  const archiveEmailAction = useEmailStore((s) => s.archiveEmail);

  const swipeLeftAction = useSettingsStore((s) => s.swipeLeftAction);
  const swipeRightAction = useSettingsStore((s) => s.swipeRightAction);
  const networkOnline = useNetworkStore((s) => s.online);

  const archiveMailboxId = React.useMemo(
    () => mailboxes.find((m) => m.role === 'archive')?.id ?? null,
    [mailboxes],
  );
  const trashMailboxId = React.useMemo(
    () => mailboxes.find((m) => m.role === 'trash')?.id ?? null,
    [mailboxes],
  );
  const junkMailboxId = React.useMemo(
    () => mailboxes.find((m) => m.role === 'junk' || m.role === 'spam')?.id ?? null,
    [mailboxes],
  );

  // Move-to-folder picker triggered by the swipe action.
  const [pendingMoveId, setPendingMoveId] = React.useState<string | null>(null);

  // Selection state
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const selectionMode = selectedIds.size > 0;
  const allSelected =
    emails.length > 0 && emails.every((e) => selectedIds.has(e.id));

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

  const handleRowPress = React.useCallback((id: string) => {
    if (selectionModeRef.current) {
      toggleSelect(id);
    } else {
      const email = emailsRef.current.find((e) => e.id === id);
      if (email) onEmailPressRef.current?.(email);
    }
  }, [toggleSelect]);

  const handleSwipeAction = React.useCallback((id: string, action: SwipeAction) => {
    if (action === 'none') return;
    const email = emailsRef.current.find((e) => e.id === id);
    if (!email || !currentMailboxId) return;
    switch (action) {
      case 'archive':
        if (archiveMailboxId && currentMailboxId !== archiveMailboxId) {
          void archiveEmailAction(id);
        }
        break;
      case 'delete':
        if (trashMailboxId) {
          void deleteEmailAction(id, trashMailboxId, currentMailboxId);
        }
        break;
      case 'spam':
        if (junkMailboxId && currentMailboxId !== junkMailboxId) {
          void moveToMailboxAction(id, currentMailboxId, junkMailboxId);
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
    currentMailboxId, archiveMailboxId, trashMailboxId, junkMailboxId,
    moveToMailboxAction, archiveEmailAction, deleteEmailAction,
    markRead, markUnread, toggleStar, togglePin,
  ]);

  const renderEmailRow = React.useCallback(
    ({ item }: { item: Email }) => (
      <SwipeableRow
        leftAction={selectionMode ? 'none' : swipeLeftAction}
        rightAction={selectionMode ? 'none' : swipeRightAction}
        context={{ unread: isUnread(item), starred: isStarred(item), pinned: isPinned(item) }}
        onAction={(action) => handleSwipeAction(item.id, action)}
      >
        <EmailRow
          item={item}
          selected={selectedIds.has(item.id)}
          selectionMode={selectionMode}
          onPress={handleRowPress}
          onLongPress={toggleSelect}
        />
      </SwipeableRow>
    ),
    [selectedIds, selectionMode, handleRowPress, toggleSelect, swipeLeftAction, swipeRightAction, handleSwipeAction],
  );

  const clearSelection = React.useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const toggleSelectAllVisible = React.useCallback(() => {
    setSelectedIds((prev) => {
      const allCurrent = emails.length > 0 && emails.every((e) => prev.has(e.id));
      if (allCurrent) return new Set();
      return new Set(emails.map((e) => e.id));
    });
  }, [emails]);

  // Clear selection when mailbox changes
  React.useEffect(() => {
    setSelectedIds(new Set());
  }, [currentMailboxId]);

  const selectedEmails = React.useMemo(
    () => emails.filter((e) => selectedIds.has(e.id)),
    [emails, selectedIds],
  );
  const allSelectedAreRead = selectedEmails.length > 0 && selectedEmails.every((e) => !isUnread(e));
  const allSelectedAreStarred = selectedEmails.length > 0 && selectedEmails.every((e) => isStarred(e));

  const handleBulkMarkReadToggle = async () => {
    const ids = Array.from(selectedIds);
    if (allSelectedAreRead) {
      await Promise.all(ids.map((id) => markUnread(id)));
    } else {
      await Promise.all(ids.map((id) => markRead(id)));
    }
    clearSelection();
  };

  const handleBulkStar = async () => {
    const ids = Array.from(selectedIds);
    const next = !allSelectedAreStarred;
    await Promise.all(ids.map((id) => toggleStar(id, next)));
    clearSelection();
  };

  const handleBulkDelete = async () => {
    const trash = mailboxes.find((m) => m.role === 'trash');
    if (!trash || !currentMailboxId) {
      clearSelection();
      return;
    }
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map((id) => deleteEmailAction(id, trash.id, currentMailboxId)));
    clearSelection();
  };

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
    (filters.from ? 1 : 0) +
    (filters.to ? 1 : 0) +
    (filters.subject ? 1 : 0) +
    (filters.dateAfter ? 1 : 0) +
    (filters.dateBefore ? 1 : 0) +
    (filters.hasAttachment !== undefined ? 1 : 0) +
    (filters.isStarred !== undefined ? 1 : 0) +
    (filters.isUnread !== undefined ? 1 : 0);
  const hasActiveSearchOrFilter = Boolean(storeSearchQuery) || activeFilterCount > 0;

  const cycleTriState = (key: 'hasAttachment' | 'isStarred' | 'isUnread') => {
    const current = filters[key];
    // unset → true → false → unset
    const next = current === undefined ? true : current === true ? false : undefined;
    const updated: EmailFilters = { ...filters };
    if (next === undefined) delete updated[key];
    else updated[key] = next;
    setFilters(updated);
  };

  const setFilterField = (key: keyof EmailFilters, value: string | undefined) => {
    const updated: EmailFilters = { ...filters };
    if (!value) delete updated[key];
    else (updated as Record<string, unknown>)[key] = value;
    setFilters(updated);
  };

  const [datePickerField, setDatePickerField] = React.useState<'dateAfter' | 'dateBefore' | null>(null);

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
          <Text style={styles.headerTitle}>{currentMailbox?.name ?? 'Inbox'}</Text>
          <View style={{ flex: 1 }} />
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
            placeholder="Search mail..."
            placeholderTextColor={c.textMuted}
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
              <X size={14} color={c.textMuted} />
            </Pressable>
          )}
        </View>
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

      {hasActiveSearchOrFilter && (
        <View style={styles.filterChipsRow}>
          {storeSearchQuery ? (
            <View style={styles.chip}>
              <Search size={12} color={c.textSecondary} />
              <Text style={styles.chipText} numberOfLines={1}>
                {storeSearchQuery}
              </Text>
            </View>
          ) : null}
          {filters.from ? (
            <View style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1}>From: {filters.from}</Text>
            </View>
          ) : null}
          {filters.to ? (
            <View style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1}>To: {filters.to}</Text>
            </View>
          ) : null}
          {filters.subject ? (
            <View style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1}>Subject: {filters.subject}</Text>
            </View>
          ) : null}
          {filters.dateAfter ? (
            <View style={styles.chip}>
              <CalendarDays size={12} color={c.textSecondary} />
              <Text style={styles.chipText}>After {filters.dateAfter}</Text>
            </View>
          ) : null}
          {filters.dateBefore ? (
            <View style={styles.chip}>
              <CalendarDays size={12} color={c.textSecondary} />
              <Text style={styles.chipText}>Before {filters.dateBefore}</Text>
            </View>
          ) : null}
          {filters.isUnread !== undefined && (
            <View style={styles.chip}>
              {filters.isUnread ? (
                <MailIcon size={12} color={c.textSecondary} />
              ) : (
                <MailOpen size={12} color={c.textSecondary} />
              )}
              <Text style={styles.chipText}>{filters.isUnread ? 'Unread' : 'Read'}</Text>
            </View>
          )}
          {filters.isStarred !== undefined && (
            <View style={styles.chip}>
              <Star size={12} color={c.starred} fill={filters.isStarred ? c.starred : 'transparent'} />
              <Text style={styles.chipText}>{filters.isStarred ? 'Starred' : 'Not starred'}</Text>
            </View>
          )}
          {filters.hasAttachment !== undefined && (
            <View style={styles.chip}>
              <Paperclip size={12} color={c.textSecondary} />
              <Text style={styles.chipText}>
                {filters.hasAttachment ? 'Has attachment' : 'No attachment'}
              </Text>
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

      <OfflineBanner hint={emails.length > 0 ? 'Showing cached mail' : undefined} />

      {/* Email list */}
      {loading && emails.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={c.primary} />
          <Text style={styles.loadingText}>Loading emails...</Text>
        </View>
      ) : error && emails.length === 0 ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.errorText}>
            {networkOnline ? error : 'No connection. Showing nothing because no mail has been cached yet.'}
          </Text>
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
          keyExtractor={emailKeyExtractor}
          renderItem={renderEmailRow}
          ItemSeparatorComponent={EmailRowSeparator}
          contentContainerStyle={styles.listContent}
          onEndReached={() => { void loadMoreEmails(); }}
          onEndReachedThreshold={0.3}
          refreshing={loading}
          onRefresh={() => { void refreshEmails(); }}
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
                    <Text style={styles.filterFieldLabel}>Subject</Text>
                    <TextInput
                      value={filters.subject ?? ''}
                      onChangeText={(v) => setFilterField('subject', v)}
                      placeholder="Subject contains..."
                      placeholderTextColor={c.textMuted}
                      style={styles.filterFieldInput}
                    />
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

      <MoveSheet
        visible={pendingMoveId !== null}
        onClose={() => setPendingMoveId(null)}
        mailboxes={mailboxes}
        currentMailboxId={currentMailboxId}
        onPick={(toId) => {
          const id = pendingMoveId;
          setPendingMoveId(null);
          if (id && currentMailboxId && toId !== currentMailboxId) {
            void moveToMailboxAction(id, currentMailboxId, toId);
          }
        }}
      />

      <UndoSnackbar />
    </SafeAreaView>
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
  headerTitle: { ...typography.h3, color: c.text, flex: 1 }, // text-lg font-semibold
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
  },
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
