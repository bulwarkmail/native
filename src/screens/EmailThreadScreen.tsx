import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ArrowLeft, Star, Trash2, MoreVertical, Reply, ReplyAll, Forward,
  ChevronLeft, ChevronRight, Paperclip,
} from 'lucide-react-native';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';
import EmailBodyView from '../components/EmailBodyView';
import SenderAvatar from '../components/SenderAvatar';
import { useEmailStore } from '../stores/email-store';
import type { Email } from '../api/types';
import type { RootStackParamList } from '../navigation/types';

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
  const { emailId, subject: subjectParam } = route.params;
  const insets = useSafeAreaInsets();
  const getEmailDetail = useEmailStore((s) => s.getEmailDetail);
  const markRead = useEmailStore((s) => s.markRead);
  const toggleStar = useEmailStore((s) => s.toggleStar);
  const deleteEmail = useEmailStore((s) => s.deleteEmail);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const currentMailboxId = useEmailStore((s) => s.currentMailboxId);

  const [email, setEmail] = React.useState<Email | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

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
  const onToggleStar = () => {
    if (!email) return;
    void toggleStar(email.id, !starred);
    setEmail({
      ...email,
      keywords: {
        ...email.keywords,
        ...(starred ? {} : { $flagged: true }),
      },
    });
  };

  const onDelete = () => {
    if (!email || !currentMailboxId) return;
    const trash = mailboxes.find((m) => m.role === 'trash');
    if (!trash) return;
    void deleteEmail(email.id, trash.id, currentMailboxId);
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

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Toolbar */}
      <View style={styles.toolbar}>
        <Pressable onPress={() => navigation.goBack()} style={styles.toolbarBack} hitSlop={8}>
          <ArrowLeft size={22} color={colors.text} />
        </Pressable>
        <View style={styles.toolbarActions}>
          <ToolbarButton
            icon={<Trash2 size={18} color={colors.textSecondary} />}
            label="Delete"
            onPress={onDelete}
          />
          <ToolbarButton
            icon={
              <Star
                size={18}
                color={starred ? colors.starred : colors.textSecondary}
                fill={starred ? colors.starred : 'transparent'}
              />
            }
            label="Star"
            onPress={onToggleStar}
          />
          <ToolbarButton
            icon={<MoreVertical size={18} color={colors.textSecondary} />}
            label="More"
          />
        </View>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
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
                      color={starred ? colors.starred : colors.textMuted}
                      fill={starred ? colors.starred : 'transparent'}
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
                    {email.to?.map((t) => t.name || t.email).join(', ') || '—'}
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
                      <Paperclip size={14} color={colors.textMuted} />
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
              icon={<ChevronLeft size={20} color={colors.textMuted} />}
              label="Prev"
              disabled
            />
            <BottomBarButton
              icon={<Reply size={20} color={colors.textSecondary} />}
              label="Reply"
              onPress={() => navigateCompose('reply')}
            />
            <BottomBarButton
              icon={<ReplyAll size={20} color={colors.textSecondary} />}
              label="Reply All"
              onPress={() => navigateCompose('replyAll')}
            />
            <BottomBarButton
              icon={<Forward size={20} color={colors.textSecondary} />}
              label="Forward"
              onPress={() => navigateCompose('forward')}
            />
            <BottomBarButton
              icon={<ChevronRight size={20} color={colors.textMuted} />}
              label="Next"
              disabled
            />
          </View>
        </>
      ) : null}
    </SafeAreaView>
  );
}

function ToolbarButton({
  icon, label, onPress,
}: { icon: React.ReactNode; label: string; onPress?: () => void }) {
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  // Top toolbar
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
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
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    minHeight: 44,
  },
  toolbarActionLabel: {
    ...typography.small,
    color: colors.textSecondary,
  },

  // Content
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  errorText: { ...typography.body, color: colors.error, textAlign: 'center' },
  scroll: { flex: 1, backgroundColor: colors.background },

  // Subject block
  subjectBlock: {
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
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
    color: colors.text,
    letterSpacing: -0.2,
  },
  subjectMeta: {
    alignItems: 'flex-end',
  },
  subjectDate: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  subjectSize: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
  },

  // Sender block
  senderBlock: {
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
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
    color: colors.text,
  },
  senderEmail: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  senderRecipients: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 4,
  },
  senderRecipientsLabel: {
    color: colors.textMuted,
  },

  // Attachments
  attachmentsBlock: {
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
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
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
  },
  attachmentName: {
    ...typography.caption,
    color: colors.text,
    maxWidth: 180,
  },
  attachmentSize: {
    ...typography.small,
    color: colors.textMuted,
  },

  // Body
  bodyBlock: {
    backgroundColor: colors.background,
  },

  // Bottom bar
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.border,
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
    color: colors.textSecondary,
  },
  bottomBarLabelDisabled: {
    color: colors.textMuted,
  },
});
