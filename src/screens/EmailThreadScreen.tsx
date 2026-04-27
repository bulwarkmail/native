import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator,
  Modal, useWindowDimensions, Animated, Easing, Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ArrowLeft, Star, Trash2, MoreVertical, Reply, ReplyAll, Forward,
  ChevronLeft, ChevronRight, Paperclip, Archive, Mail, MailOpen,
  FolderInput, ShieldAlert, ShieldCheck, X, Check,
  Inbox, Send, File as FileIcon, Ban, Folder, Code, Download, Tag,
} from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import EmailBodyView from '../components/EmailBodyView';
import SenderAvatar from '../components/SenderAvatar';
import { useEmailStore } from '../stores/email-store';
import { setEmailKeywords } from '../api/email';
import { shareEmailEml } from '../lib/email-export';
import { useKeywordsStore, keywordToken, type KeywordDef } from '../stores/keywords-store';
import { buildMailboxTree, flattenVisible, type MailboxNode } from '../lib/mailbox-tree';
import { useSheetDrag } from '../lib/use-sheet-drag';
import type { Email, Mailbox } from '../api/types';
import type { RootStackParamList } from '../navigation/types';

function moveTargetIcon(role: string | null | undefined, name: string): LucideIcon {
  const lower = name.toLowerCase();
  if (role === 'inbox' || lower.includes('inbox')) return Inbox;
  if (role === 'sent' || lower.includes('sent')) return Send;
  if (role === 'drafts' || lower.includes('draft')) return FileIcon;
  if (role === 'trash' || lower.includes('trash') || lower.includes('deleted')) return Trash2;
  if (role === 'junk' || role === 'spam' || lower.includes('junk') || lower.includes('spam')) return Ban;
  if (role === 'archive' || lower.includes('archive')) return Archive;
  return Folder;
}

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
  const { emailId, subject: subjectParam } = route.params;
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const getEmailDetail = useEmailStore((s) => s.getEmailDetail);
  const markRead = useEmailStore((s) => s.markRead);
  const deleteEmail = useEmailStore((s) => s.deleteEmail);
  const moveToMailbox = useEmailStore((s) => s.moveToMailbox);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const currentMailboxId = useEmailStore((s) => s.currentMailboxId);
  const emails = useEmailStore((s) => s.emails);

  const currentIndex = emails.findIndex((e) => e.id === emailId);
  const prevEmail = currentIndex > 0 ? emails[currentIndex - 1] : null;
  const nextEmail = currentIndex >= 0 && currentIndex < emails.length - 1 ? emails[currentIndex + 1] : null;
  const goToEmail = (target: { id: string; threadId: string; subject: string }) => {
    navigation.replace('EmailThread', {
      emailId: target.id,
      threadId: target.threadId,
      subject: target.subject,
    });
  };

  const [email, setEmail] = React.useState<Email | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [moreMenuOpen, setMoreMenuOpen] = React.useState(false);
  const [moveMenuOpen, setMoveMenuOpen] = React.useState(false);
  const [tagMenuOpen, setTagMenuOpen] = React.useState(false);
  const keywordDefs = useKeywordsStore((s) => s.keywords);
  const hydrateKeywords = useKeywordsStore((s) => s.hydrate);
  const keywordsHydrated = useKeywordsStore((s) => s.hydrated);
  React.useEffect(() => { if (!keywordsHydrated) void hydrateKeywords(); }, [keywordsHydrated, hydrateKeywords]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const fetched = await getEmailDetail(emailId);
        if (cancelled) return;
        setEmail(fetched);
        if (fetched && !fetched.keywords?.$seen) {
          void markRead(emailId);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load email');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [emailId, getEmailDetail, markRead]);

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

  const updateLocalKeywords = (next: Record<string, boolean>) => {
    setEmail((prev) => (prev ? { ...prev, keywords: next } : prev));
  };

  const onToggleKeyword = (token: string) => {
    if (!email) return;
    const next = { ...email.keywords };
    if (next[token]) delete next[token];
    else next[token] = true;
    updateLocalKeywords(next);
    void setEmailKeywords(email.id, next);
  };

  const onToggleStar = () => {
    if (!email) return;
    const next = { ...email.keywords };
    if (starred) delete next.$flagged;
    else next.$flagged = true;
    updateLocalKeywords(next);
    void setEmailKeywords(email.id, next);
  };

  const onToggleUnread = () => {
    if (!email) return;
    if (unread) {
      void markRead(email.id);
      updateLocalKeywords({ ...email.keywords, $seen: true });
    } else {
      const next = { ...email.keywords };
      delete next.$seen;
      updateLocalKeywords(next);
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
    void moveToMailbox(email.id, currentMailboxId, archiveMailbox.id);
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
        inReplyTo: email.id,
      },
    });
  };

  const subject = email?.subject ?? subjectParam ?? '(no subject)';
  const from = email?.from?.[0];
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

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={c.primary} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : email ? (
        <>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={{ paddingBottom: bottomBarHeight + spacing.lg }}
          >
            {/* Subject block */}
            <View style={styles.subjectBlock}>
              <View style={styles.subjectRow}>
                <View style={styles.subjectMain}>
                  <Pressable onPress={onToggleStar} hitSlop={8} style={styles.subjectStar}>
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
            </View>

            {/* Attachments chips */}
            {email.attachments && email.attachments.length > 0 && (
              <View style={styles.attachmentsBlock}>
                <View style={styles.attachmentsRow}>
                  {email.attachments.map((att, idx) => (
                    <View key={att.blobId ?? idx} style={styles.attachmentChip}>
                      <Paperclip size={14} color={c.textMuted} />
                      <Text style={styles.attachmentName} numberOfLines={1}>
                        {att.name || 'attachment'}
                      </Text>
                      <Text style={styles.attachmentSize}>{formatSize(att.size)}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Body */}
            <View style={styles.bodyBlock}>
              <EmailBodyView email={email} senderEmail={from?.email} />
            </View>
          </ScrollView>

          {/* Bottom action bar */}
          <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 4) }]}>
            <BottomBarButton
              icon={<ChevronLeft size={20} color={c.textMuted} />}
              label="Prev"
              onPress={prevEmail ? () => goToEmail(prevEmail) : undefined}
              disabled={!prevEmail}
            />
            <BottomBarButton
              icon={<Reply size={20} color={c.textSecondary} />}
              label="Reply"
              onPress={() => navigateCompose('reply')}
            />
            <BottomBarButton
              icon={<ReplyAll size={20} color={c.textSecondary} />}
              label="Reply All"
              onPress={() => navigateCompose('replyAll')}
            />
            <BottomBarButton
              icon={<Forward size={20} color={c.textSecondary} />}
              label="Forward"
              onPress={() => navigateCompose('forward')}
            />
            <BottomBarButton
              icon={<ChevronRight size={20} color={c.textMuted} />}
              label="Next"
              onPress={nextEmail ? () => goToEmail(nextEmail) : undefined}
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
            await shareEmailEml(email.blobId, email.subject);
          } catch (e) {
            Alert.alert('Export failed', e instanceof Error ? e.message : String(e));
          }
        }}
      />

      <MoveMenuSheet
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

interface MoveMenuSheetProps {
  visible: boolean;
  onClose: () => void;
  mailboxes: Mailbox[];
  currentMailboxId: string | null;
  onPick: (id: string) => void;
}

function MoveMenuSheet({ visible, onClose, mailboxes, currentMailboxId, onPick }: MoveMenuSheetProps) {
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

  const visibleNodes = React.useMemo(() => {
    const tree = buildMailboxTree(mailboxes);
    const expanded = new Set<string>();
    const collect = (nodes: MailboxNode[]) => {
      for (const n of nodes) {
        if (n.children.length > 0) {
          expanded.add(n.id);
          collect(n.children);
        }
      }
    };
    collect(tree);
    return flattenVisible(tree, expanded);
  }, [mailboxes]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.sheetOverlay, { opacity: overlayOpacity }]}>
        <Pressable style={styles.sheetOverlayPress} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          styles.sheetTall,
          { paddingBottom: Math.max(insets.bottom, spacing.md), transform: [{ translateY: slideY }] },
        ]}
      >
        <View {...dragHandlers}>
          <View style={styles.sheetHandleHit}>
            <View style={styles.sheetHandle} />
          </View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Move to folder</Text>
            <Pressable onPress={onClose} hitSlop={8} style={styles.sheetClose}>
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
        <ScrollView>
          {visibleNodes.map((node) => {
            const Icon = moveTargetIcon(node.role, node.name);
            const isCurrent = node.id === currentMailboxId;
            const canTarget = node.myRights?.mayAddItems !== false && !isCurrent;
            return (
              <Pressable
                key={node.id}
                onPress={canTarget ? () => onPick(node.id) : undefined}
                disabled={!canTarget}
                style={({ pressed }) => [
                  styles.moveRow,
                  pressed && canTarget && styles.moveRowPressed,
                  { paddingLeft: spacing.lg + node.depth * 16 },
                ]}
              >
                <Icon size={16} color={canTarget ? c.textSecondary : c.textMuted} />
                <Text
                  style={[styles.moveRowLabel, !canTarget && styles.moveRowLabelDisabled]}
                  numberOfLines={1}
                >
                  {node.name}
                </Text>
                {isCurrent && <Check size={14} color={c.textMuted} />}
              </Pressable>
            );
          })}
        </ScrollView>
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
  return (
    <Pressable onPress={onPress} style={styles.toolbarAction} hitSlop={6}>
      {icon}
      <Text style={styles.toolbarActionLabel}>{label}</Text>
    </Pressable>
  );
}

function BottomBarButton({
  icon, label, onPress, disabled,
}: { icon: React.ReactNode; label: string; onPress?: () => void; disabled?: boolean }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={[styles.bottomBarBtn, disabled && styles.bottomBarBtnDisabled]}
      hitSlop={4}
    >
      {icon}
      <Text style={[styles.bottomBarLabel, disabled && styles.bottomBarLabelDisabled]}>
        {label}
      </Text>
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
  attachmentName: {
    ...typography.caption,
    color: c.text,
    maxWidth: 180,
  },
  attachmentSize: {
    ...typography.small,
    color: c.textMuted,
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
  sheetTall: {
    maxHeight: '75%',
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

  // Move folder row
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.lg,
    paddingVertical: spacing.sm + 2,
    minHeight: 44,
  },
  moveRowPressed: { backgroundColor: c.surfaceHover },
  moveRowLabel: {
    ...typography.body,
    color: c.text,
    flex: 1,
  },
  moveRowLabelDisabled: {
    color: c.textMuted,
  },
  });
}
