import React from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, TextInput, Image, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Search, SquarePen, Menu, Filter, Square,
  Star, Paperclip, MessageSquare, XCircle, Circle, Reply, Forward,
} from 'lucide-react-native';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';
import { Button } from '../components';
import { useEmailStore } from '../stores/email-store';
import type { Email } from '../api/types';

// Avatar color palette — deterministic based on initials hash
const AVATAR_PALETTE = [
  '#14b8a6', '#a855f7', '#f97316', '#22c55e', '#3b82f6',
  '#ef4444', '#eab308', '#ec4899', '#6366f1', '#06b6d4',
];

function getInitials(name: string): string {
  // Handle multi-person names like "Sophie Müller, Lars Johansson"
  const first = name.split(',')[0].trim();
  const parts = first.split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return first.substring(0, 2).toUpperCase();
}

function getAvatarColor(initials: string): string {
  let hash = 0;
  for (let i = 0; i < initials.length; i++) hash = initials.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function getSenderName(email: Email): string {
  return email.from?.[0]?.name || email.from?.[0]?.email || 'Unknown';
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
  const initials = getInitials(senderName);
  const avatarColor = getAvatarColor(initials);
  const unread = isUnread(item);
  const starred = isStarred(item);

  return (
    <Pressable
      style={({ pressed }) => [styles.emailRow, pressed && styles.emailRowPressed]}
      onPress={onPress}
    >
      {/* Avatar */}
      <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
        <Text style={styles.avatarText}>{initials}</Text>
      </View>

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
  onDrawerOpen?: () => void;
}

export default function EmailListScreen({ onEmailPress, onComposePress, onDrawerOpen }: EmailListScreenProps) {
  const [searchQuery, setSearchQuery] = React.useState('');
  const emails = useEmailStore((s) => s.emails);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const loading = useEmailStore((s) => s.loading);
  const currentMailboxId = useEmailStore((s) => s.currentMailboxId);
  const fetchMailboxes = useEmailStore((s) => s.fetchMailboxes);
  const selectMailbox = useEmailStore((s) => s.selectMailbox);
  const loadMoreEmails = useEmailStore((s) => s.loadMoreEmails);
  const refreshEmails = useEmailStore((s) => s.refreshEmails);

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
        <Pressable onPress={onDrawerOpen} style={styles.headerButton}>
          <Menu size={20} color={colors.textMuted} />
        </Pressable>
        <Text style={styles.headerTitle}>Inbox</Text>
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
            placeholder="Search mail... (press /)"
            placeholderTextColor={colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
        <Pressable style={styles.filterButton}>
          <Filter size={18} color={colors.textMuted} />
        </Pressable>
      </View>

      {/* Email list */}
      {loading && emails.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.loadingText}>Loading emails...</Text>
        </View>
      ) : emails.length === 0 ? (
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>No emails</Text>
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
        <SquarePen size={24} color={colors.primaryForeground} />
      </Pressable>
    </SafeAreaView>
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
  // Avatar: md = 40px (w-10 h-10), shadow-sm
  avatar: {
    width: componentSizes.avatarMd,
    height: componentSizes.avatarMd,
    borderRadius: componentSizes.avatarMd / 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 1,
    elevation: 1,
  },
  avatarText: { fontSize: 16, fontWeight: '700', color: '#ffffff' }, // font-bold text-white
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
    backgroundColor: colors.primary, // bg-primary (#3b82f6)
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
});

export type { EmailListScreenProps };
