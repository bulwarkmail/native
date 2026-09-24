import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { Paperclip, Reply, ReplyAll, Forward, Star } from 'lucide-react-native';
import type { Email } from '../../api/types';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import SenderAvatar from '../SenderAvatar';
import { MessageContent, type MessageContentProps } from './MessageContent';
import { emailDisplayDate, formatHeaderDate, formatHeaderTime } from '../../lib/email-date';
import { singleLine } from '../../lib/single-line';

interface Props extends MessageContentProps {
  expanded: boolean;
  /** Opened, with its body still on the way: the summary row with a spinner. */
  loading?: boolean;
  onToggleExpanded: () => void;
  onReply: (mode: 'reply' | 'replyAll' | 'forward', email: Email) => void;
}

/**
 * One message of a conversation: a collapsed summary row (sender, date,
 * preview) that expands into the full message with its own reply / forward
 * actions - the webmail's thread-conversation-view cards.
 */
export function ThreadMessageCard({ expanded, loading, onToggleExpanded, onReply, ...content }: Props) {
  const { email, onToggleStar } = content;
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const from = email.from?.[0];
  const unread = !email.keywords?.$seen;
  const starred = !!email.keywords?.$flagged;
  const date = emailDisplayDate(email);

  if (!expanded) {
    return (
      <Pressable onPress={onToggleExpanded} style={({ pressed }) => [styles.collapsed, pressed && styles.pressed]}>
        <SenderAvatar name={from?.name} email={from?.email} size={componentSizes.avatarSm} />
        <View style={styles.collapsedInfo}>
          <View style={styles.collapsedTop}>
            <Text style={[styles.collapsedName, unread && styles.unread]} numberOfLines={1}>
              {from?.name || from?.email || t('email_viewer.unknown_sender', 'Unknown')}
            </Text>
            {email.hasAttachment && <Paperclip size={12} color={c.textMuted} />}
            <Text style={styles.collapsedDate}>{formatHeaderDate(date, locale)} {formatHeaderTime(date, timeFormat, locale)}</Text>
          </View>
          <Text style={styles.collapsedPreview} numberOfLines={1}>{singleLine(email.preview)}</Text>
        </View>
        {loading && <ActivityIndicator size="small" color={c.textMuted} />}
        {starred && <Star size={14} color={c.starred} fill={c.starred} />}
      </Pressable>
    );
  }

  return (
    <View style={styles.expanded}>
      <Pressable onPress={onToggleExpanded} style={styles.collapseHandle} hitSlop={6} accessibilityLabel={t('threads.collapse', 'Collapse conversation')} />
      <MessageContent {...content} compact={false} onToggleStar={onToggleStar} />
      <View style={styles.actions}>
        <Pressable style={styles.actionBtn} onPress={() => onReply('reply', email)} hitSlop={4}>
          <Reply size={16} color={c.textSecondary} />
          <Text style={styles.actionLabel}>{t('email_viewer.reply', 'Reply')}</Text>
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={() => onReply('replyAll', email)} hitSlop={4}>
          <ReplyAll size={16} color={c.textSecondary} />
          <Text style={styles.actionLabel}>{t('email_viewer.reply_all', 'Reply All')}</Text>
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={() => onReply('forward', email)} hitSlop={4}>
          <Forward size={16} color={c.textSecondary} />
          <Text style={styles.actionLabel}>{t('email_viewer.forward', 'Forward')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    collapsed: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      backgroundColor: c.surface,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    pressed: { backgroundColor: c.surfaceHover },
    collapsedInfo: { flex: 1, minWidth: 0 },
    collapsedTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    collapsedName: { ...typography.body, color: c.text, flex: 1 },
    unread: { fontWeight: '700' },
    collapsedDate: { ...typography.small, color: c.textMuted },
    collapsedPreview: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    expanded: {
      backgroundColor: c.background,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    collapseHandle: {
      height: 6,
      backgroundColor: c.surfaceHover,
      borderRadius: radius.xs,
    },
    actions: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    actionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    actionLabel: { ...typography.caption, color: c.textSecondary },
  });
}
