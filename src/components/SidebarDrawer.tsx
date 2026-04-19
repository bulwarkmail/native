import React from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Modal,
  Animated, Dimensions, Easing,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Inbox, Send, File as FileIcon, Trash2, Ban, Archive, Star,
  Folder, FolderOpen, ChevronDown, ChevronRight, X, Settings, LogOut, Check, Plus,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { colors, spacing, radius, typography } from '../theme/tokens';
import { useEmailStore } from '../stores/email-store';
import { useAuthStore } from '../stores/auth-store';
import { useAccountStore } from '../stores/account-store';
import { MAX_ACCOUNTS } from '../lib/account-utils';
import { buildMailboxTree, flattenVisible, type MailboxNode } from '../lib/mailbox-tree';
import { generateAvatarColor, getAccountInitials } from '../lib/avatar-utils';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';

const CHEVRON_SLOT = 20;
const INDENT_STEP = 12;
const ROW_PX_BASE = 8;

const STORAGE_KEYS = {
  expanded: 'sidebar:expandedMailboxes',
  foldersExpanded: 'sidebar:foldersExpanded',
};

function iconFor(
  role: string | null | undefined,
  name: string | undefined,
  hasChildren: boolean,
  isExpanded: boolean,
): LucideIcon {
  const lower = (name ?? '').toLowerCase();
  if (role === 'inbox' || lower.includes('inbox')) return Inbox;
  if (role === 'sent' || lower.includes('sent')) return Send;
  if (role === 'drafts' || lower.includes('draft')) return FileIcon;
  if (role === 'trash' || lower.includes('trash') || lower.includes('deleted')) return Trash2;
  if (role === 'junk' || role === 'spam' || lower.includes('junk') || lower.includes('spam')) return Ban;
  if (role === 'archive' || lower.includes('archive')) return Archive;
  if (lower.includes('star') || lower.includes('flag')) return Star;
  if (hasChildren) return isExpanded ? FolderOpen : Folder;
  return Folder;
}

const ROLE_COLOR: Record<string, string> = {
  inbox: '#60a5fa',
  sent: '#4ade80',
  drafts: '#a78bfa',
  trash: colors.textMuted,
  junk: '#f87171',
  archive: '#fbbf24',
};

function iconColor(role: string | null | undefined, isSelected: boolean): string {
  if (role && ROLE_COLOR[role]) return ROLE_COLOR[role];
  return isSelected ? colors.text : colors.textSecondary;
}

function RowCounts({ unread, total }: { unread: number; total: number }) {
  if (unread === 0 && total === 0) return null;
  return (
    <View style={styles.counts}>
      {unread > 0 && <Text style={styles.countUnread}>{unread}</Text>}
      {unread > 0 && total > 0 && <Text style={styles.countSep}>/</Text>}
      {total > 0 && <Text style={styles.countTotal}>{total}</Text>}
    </View>
  );
}

interface SidebarRowProps {
  icon: React.ReactElement;
  label: string;
  depth: number;
  isSelected: boolean;
  unread: number;
  total: number;
  hasChildren: boolean;
  isExpanded: boolean;
  onPress: () => void;
  onToggleExpand: () => void;
}

function SidebarRow({
  icon, label, depth, isSelected, unread, total,
  hasChildren, isExpanded, onPress, onToggleExpand,
}: SidebarRowProps) {
  const leftPad = ROW_PX_BASE + depth * INDENT_STEP;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        isSelected && styles.rowSelected,
        pressed && !isSelected && styles.rowPressed,
      ]}
    >
      <View style={[styles.rowIndent, { paddingLeft: leftPad }]}>
        {hasChildren ? (
          <Pressable
            onPress={onToggleExpand}
            hitSlop={6}
            style={styles.chevron}
          >
            {isExpanded ? (
              <ChevronDown size={12} color={colors.textMuted} />
            ) : (
              <ChevronRight size={12} color={colors.textMuted} />
            )}
          </Pressable>
        ) : (
          <View style={styles.chevron} />
        )}
      </View>
      <View style={styles.rowIcon}>{icon}</View>
      <Text
        style={[styles.rowLabel, isSelected && styles.rowLabelSelected]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <RowCounts unread={unread} total={total} />
    </Pressable>
  );
}

interface SidebarDrawerProps {
  visible: boolean;
  onClose: () => void;
}

export default function SidebarDrawer({ visible, onClose }: SidebarDrawerProps) {
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const currentMailboxId = useEmailStore((s) => s.currentMailboxId);
  const selectMailbox = useEmailStore((s) => s.selectMailbox);
  const username = useAuthStore((s) => s.username);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const logout = useAuthStore((s) => s.logout);
  const logoutAll = useAuthStore((s) => s.logoutAll);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const setDefaultAccount = useAccountStore((s) => s.setDefaultAccount);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const [foldersExpanded, setFoldersExpanded] = React.useState(true);
  const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(() => new Set());
  const [accountMenuOpen, setAccountMenuOpen] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      try {
        const [rawExp, rawFld] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.expanded),
          AsyncStorage.getItem(STORAGE_KEYS.foldersExpanded),
        ]);
        if (rawExp) {
          try {
            const ids = JSON.parse(rawExp) as string[];
            if (Array.isArray(ids)) setExpandedFolders(new Set(ids));
          } catch { /* ignore */ }
        } else {
          const tree = buildMailboxTree(mailboxes);
          const collect = (nodes: MailboxNode[]): string[] => {
            const ids: string[] = [];
            for (const n of nodes) {
              if (n.children.length > 0) { ids.push(n.id); ids.push(...collect(n.children)); }
            }
            return ids;
          };
          setExpandedFolders(new Set(collect(tree)));
        }
        if (rawFld != null) setFoldersExpanded(rawFld === 'true');
      } catch { /* ignore */ }
    })();
  }, [mailboxes]);

  const tree = React.useMemo(() => buildMailboxTree(mailboxes), [mailboxes]);
  const visibleNodes = React.useMemo(
    () => flattenVisible(tree, expandedFolders),
    [tree, expandedFolders],
  );

  const persistExpanded = React.useCallback(async (next: Set<string>) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.expanded, JSON.stringify(Array.from(next)));
    } catch { /* ignore */ }
  }, []);

  const toggleExpand = React.useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      void persistExpanded(next);
      return next;
    });
  }, [persistExpanded]);

  const toggleFoldersSection = React.useCallback(() => {
    setFoldersExpanded((prev) => {
      const next = !prev;
      void AsyncStorage.setItem(STORAGE_KEYS.foldersExpanded, String(next)).catch(() => {});
      return next;
    });
  }, []);

  const handleSelect = React.useCallback((id: string) => {
    void selectMailbox(id);
    onClose();
  }, [selectMailbox, onClose]);

  const slideX = React.useRef(new Animated.Value(-Dimensions.get('window').width)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideX, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideX, { toValue: -Dimensions.get('window').width, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideX, overlayOpacity]);

  const accountEmail = username || '';
  const initials = React.useMemo(
    () => getAccountInitials('', accountEmail),
    [accountEmail],
  );
  const avatarBg = React.useMemo(
    () => (accountEmail ? generateAvatarColor(accountEmail) : colors.primary),
    [accountEmail],
  );
  const hostname = React.useMemo(() => {
    if (!serverUrl) return '';
    try { return new URL(serverUrl).hostname; } catch { return serverUrl; }
  }, [serverUrl]);
  const accountEmailFull = React.useMemo(() => {
    if (!username) return hostname;
    if (username.includes('@')) return username;
    return hostname ? `${username}@${hostname}` : username;
  }, [username, hostname]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={styles.overlayPress} onPress={onClose} />
      </Animated.View>

      <Animated.View style={[styles.drawer, { transform: [{ translateX: slideX }] }]}>
        <SafeAreaView style={styles.drawerSafe} edges={['top', 'bottom', 'left']}>
          {/* Header: close + account switcher */}
          <View style={styles.header}>
            <Pressable onPress={onClose} style={styles.headerClose} hitSlop={8}>
              <X size={20} color={colors.text} />
            </Pressable>
            <Pressable
              onPress={() => setAccountMenuOpen((v) => !v)}
              style={({ pressed }) => [styles.account, pressed && styles.accountPressed]}
            >
              <View style={[styles.accountAvatar, { backgroundColor: avatarBg }]}>
                <Text style={styles.accountAvatarText}>{initials}</Text>
              </View>
              <View style={styles.accountInfo}>
                <Text style={styles.accountName} numberOfLines={1}>{username || 'Account'}</Text>
                {hostname ? (
                  <Text style={styles.accountEmail} numberOfLines={1}>{hostname}</Text>
                ) : null}
              </View>
              <ChevronDown
                size={16}
                color={colors.textMuted}
                style={accountMenuOpen ? styles.accountChevronOpen : undefined}
              />
            </Pressable>
          </View>

          {accountMenuOpen && (
            <View style={styles.accountMenu}>
              <ScrollView style={styles.accountMenuList}>
                {accounts.map((acc) => {
                  const isActive = acc.id === activeAccountId;
                  let accHost = '';
                  try { accHost = new URL(acc.serverUrl).hostname; } catch { accHost = acc.serverUrl; }
                  const accEmail = acc.email || (acc.username.includes('@')
                    ? acc.username
                    : accHost ? `${acc.username}@${accHost}` : acc.username);
                  return (
                    <Pressable
                      key={acc.id}
                      disabled={isActive}
                      onPress={() => {
                        setAccountMenuOpen(false);
                        onClose();
                        void switchAccount(acc.id);
                      }}
                      style={({ pressed }) => [
                        styles.accountMenuRow,
                        isActive && styles.accountMenuRowActive,
                        pressed && !isActive && styles.accountMenuActionPressed,
                      ]}
                    >
                      <View style={styles.accountMenuAvatarWrap}>
                        <View style={[styles.accountMenuAvatar, { backgroundColor: acc.avatarColor }]}>
                          <Text style={styles.accountMenuAvatarText}>
                            {getAccountInitials(acc.displayName, acc.email || acc.username)}
                          </Text>
                        </View>
                        {isActive && (
                          <View style={styles.accountMenuCheckBadge}>
                            <Check size={10} color={colors.primaryForeground} strokeWidth={3} />
                          </View>
                        )}
                      </View>
                      <View style={styles.accountMenuInfo}>
                        <View style={styles.accountMenuNameRow}>
                          <Text style={styles.accountMenuName} numberOfLines={1}>
                            {acc.displayName || acc.username}
                          </Text>
                          {acc.isDefault && (
                            <Star size={12} color="#f59e0b" fill="#f59e0b" />
                          )}
                        </View>
                        <Text style={styles.accountMenuHost} numberOfLines={1}>{accEmail}</Text>
                        <View style={styles.accountMenuStatusRow}>
                          <View style={[
                            styles.accountMenuStatusDot,
                            !acc.isConnected && styles.accountMenuStatusDotOffline,
                          ]} />
                          <Text style={styles.accountMenuStatusText} numberOfLines={1}>{accHost}</Text>
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {accounts.length < MAX_ACCOUNTS && (
                <>
                  <View style={styles.accountMenuDivider} />
                  <Pressable
                    style={({ pressed }) => [
                      styles.accountMenuAction,
                      pressed && styles.accountMenuActionPressed,
                    ]}
                    onPress={() => {
                      setAccountMenuOpen(false);
                      onClose();
                      navigation.navigate('AddAccount');
                    }}
                  >
                    <Plus size={16} color={colors.textSecondary} />
                    <Text style={styles.accountMenuActionText}>Add account</Text>
                  </Pressable>
                </>
              )}

              <View style={styles.accountMenuDivider} />
              {accounts.length > 1 && activeAccountId && (() => {
                const active = accounts.find((a) => a.id === activeAccountId);
                if (!active || active.isDefault) return null;
                return (
                  <Pressable
                    style={({ pressed }) => [
                      styles.accountMenuAction,
                      pressed && styles.accountMenuActionPressed,
                    ]}
                    onPress={() => setDefaultAccount(active.id)}
                  >
                    <Star size={16} color={colors.textSecondary} />
                    <Text style={styles.accountMenuActionText}>Set as default</Text>
                  </Pressable>
                );
              })()}
              <Pressable
                style={({ pressed }) => [
                  styles.accountMenuAction,
                  pressed && styles.accountMenuActionPressed,
                ]}
                onPress={() => { setAccountMenuOpen(false); onClose(); void logout(); }}
              >
                <LogOut size={16} color={colors.textSecondary} />
                <Text style={styles.accountMenuActionText} numberOfLines={1}>
                  Sign out of {accountEmailFull || 'account'}
                </Text>
              </Pressable>
              {accounts.length > 1 && (
                <Pressable
                  style={({ pressed }) => [
                    styles.accountMenuAction,
                    pressed && styles.accountMenuActionPressed,
                  ]}
                  onPress={() => { setAccountMenuOpen(false); onClose(); void logoutAll(); }}
                >
                  <LogOut size={16} color={colors.error} />
                  <Text style={[styles.accountMenuActionText, { color: colors.error }]}>
                    Sign out all
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            {/* Folders section */}
            <Pressable style={styles.sectionHeader} onPress={toggleFoldersSection}>
              {foldersExpanded ? (
                <ChevronDown size={14} color={colors.textMuted} />
              ) : (
                <ChevronRight size={14} color={colors.textMuted} />
              )}
              <Text style={styles.sectionHeaderText}>Folders</Text>
              <View style={{ flex: 1 }} />
              <View style={styles.sectionSettings}>
                <Settings size={14} color={colors.textMuted} />
              </View>
            </Pressable>

            {foldersExpanded && (
              mailboxes.length === 0 ? (
                <Text style={styles.empty}>Loading mailboxes…</Text>
              ) : (
                visibleNodes.map((node) => {
                  const hasChildren = node.children.length > 0;
                  const isExpanded = expandedFolders.has(node.id);
                  const Icon = iconFor(node.role, node.name, hasChildren, isExpanded);
                  const isSelected = node.id === currentMailboxId;
                  return (
                    <SidebarRow
                      key={node.id}
                      icon={<Icon size={16} color={iconColor(node.role, isSelected)} />}
                      label={node.name}
                      depth={node.depth}
                      isSelected={isSelected}
                      unread={node.unreadEmails}
                      total={node.totalEmails}
                      hasChildren={hasChildren}
                      isExpanded={isExpanded}
                      onPress={() => handleSelect(node.id)}
                      onToggleExpand={() => toggleExpand(node.id)}
                    />
                  );
                })
              )
            )}
          </ScrollView>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  overlayPress: { flex: 1 },
  drawer: {
    position: 'absolute',
    top: 0, bottom: 0, left: 0,
    width: '85%',
    maxWidth: 340,
    backgroundColor: '#262626', // matches webmail bg-secondary (dark mode)
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  drawerSafe: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerClose: {
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm,
  },
  account: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
  accountPressed: { backgroundColor: colors.surfaceHover },
  accountChevronOpen: { transform: [{ rotate: '180deg' }] },
  accountAvatar: {
    width: 36, height: 36,
    borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  accountAvatarText: {
    ...typography.bodySemibold,
    color: colors.primaryForeground,
  },
  accountInfo: { flex: 1, minWidth: 0 },
  accountName: { ...typography.bodyMedium, color: colors.text },
  accountEmail: { ...typography.caption, color: colors.textMuted, marginTop: 1 },

  // Account menu — floating popover card under the header
  accountMenu: {
    marginHorizontal: spacing.sm,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    backgroundColor: '#1f1f1f',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    // Elevation / shadow
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  accountMenuSection: {
    paddingVertical: 4,
  },
  accountMenuList: {
    maxHeight: 260,
  },
  accountMenuRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  accountMenuRowActive: {
    backgroundColor: 'rgba(59,130,246,0.08)',
  },
  accountMenuAvatarWrap: {
    position: 'relative',
    width: 36, height: 36,
  },
  accountMenuAvatar: {
    width: 36, height: 36,
    borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  accountMenuAvatarText: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.primaryForeground,
  },
  accountMenuCheckBadge: {
    position: 'absolute',
    right: -3, bottom: -3,
    width: 16, height: 16,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#1f1f1f',
  },
  accountMenuInfo: { flex: 1, minWidth: 0, paddingTop: 1 },
  accountMenuNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  accountMenuName: {
    ...typography.bodyMedium,
    color: colors.text,
    flexShrink: 1,
    fontWeight: '600',
  },
  accountMenuHost: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
  },
  accountMenuStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
  },
  accountMenuStatusDot: {
    width: 6, height: 6,
    borderRadius: 3,
    backgroundColor: '#22c55e',
  },
  accountMenuStatusDotOffline: {
    backgroundColor: colors.textMuted,
  },
  accountMenuStatusText: {
    fontSize: 10,
    lineHeight: 12,
    color: colors.textMuted,
    flexShrink: 1,
  },
  accountMenuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  accountMenuAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    minHeight: 40,
  },
  accountMenuActionPressed: { backgroundColor: colors.surfaceHover },
  accountMenuActionText: {
    ...typography.body,
    color: colors.text,
    flexShrink: 1,
    fontSize: 13,
  },

  // Scroll
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: spacing.md },

  // Section header
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: 4,
  },
  sectionHeaderText: {
    ...typography.bodySemibold,
    color: colors.text,
  },
  sectionSettings: { padding: 4 },

  empty: {
    ...typography.body,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingRight: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  rowPressed: { backgroundColor: colors.surfaceHover },
  rowSelected: {
    backgroundColor: colors.accent,
    borderLeftColor: colors.primary,
  },
  rowIndent: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  chevron: {
    width: CHEVRON_SLOT, height: CHEVRON_SLOT,
    alignItems: 'center', justifyContent: 'center',
  },
  rowIcon: {
    width: 16, height: 16,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.sm,
  },
  rowLabel: {
    flex: 1,
    ...typography.body,
    color: colors.text,
  },
  rowLabelSelected: {
    ...typography.bodySemibold,
    color: colors.text,
  },
  counts: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    marginLeft: spacing.sm,
  },
  countUnread: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.text,
  },
  countSep: {
    ...typography.caption,
    color: colors.textMuted,
    opacity: 0.6,
  },
  countTotal: {
    ...typography.caption,
    color: colors.textMuted,
  },

});
