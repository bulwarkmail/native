import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Paperclip, Reply, ReplyAll, Forward, Star } from '../icons';
import type { Email } from '../../api/types';
import { spacing, radius, typography, typography as tokenTypography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useTypography } from '../../theme/dynamic';
// The user's text size (Settings > Accessibility), as the list has it.
type ScaledTypography = ReturnType<typeof useTypography>;
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import SenderAvatar from '../SenderAvatar';
import { MessageContent, type MessageContentProps } from './MessageContent';
import { emailDisplayDate, formatHeaderDate, formatHeaderTime } from '../../lib/email-date';
import { singleLine } from '../../lib/single-line';
import { cleanPreview } from '../../lib/preview-text';
import { useSenderWarning } from './use-sender-warning';
import { useOwnDomainAddress } from '../../lib/use-own-domain-address';
import type { CardReplyActions } from '../../lib/thread-card-actions';

interface Props extends MessageContentProps {
  expanded: boolean;
  onToggleExpanded: () => void;
  onReply: (mode: 'reply' | 'replyAll' | 'forward', email: Email) => void;
  /**
   * The message is not part of a conversation: just its content, without the
   * card's collapse handle, reply buttons and header star. Rendered through
   * the card so the content survives a conversation arriving around it.
   */
  bare?: boolean;
  /**
   * The reply row: hidden on a draft or scheduled message, disabled until
   * the full message is here (lib/thread-card-actions).
   */
  replyActions?: CardReplyActions;
}

/**
 * One message of a conversation: a collapsed summary row (sender, date,
 * preview) that expands into the full message with its own reply / forward
 * actions - the webmail's thread-conversation-view cards.
 */
export function ThreadMessageCard({
  expanded, onToggleExpanded, onReply, bare, replyActions = 'enabled', ...content
}: Props) {
  const { email, onToggleStar } = content;
  const c = useColors();
  const scaledType = useTypography();
  const styles = React.useMemo(() => makeStyles(c, scaledType), [c, scaledType]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const from = email.from?.[0];
  const unread = !email.keywords?.$seen;
  const starred = !!email.keywords?.$flagged;
  const date = emailDisplayDate(email);
  const senderWarning = useSenderWarning(expanded ? undefined : email);
  // An address on one of the user's own IDN domains reads as written (#1100).
  const formatAddress = useOwnDomainAddress();

  if (!expanded) {
    return (
      <Pressable onPress={onToggleExpanded} style={({ pressed }) => [styles.collapsed, pressed && styles.pressed]}>
        <SenderAvatar name={from?.name} email={from?.email} size={componentSizes.avatarSm} senderWarning={senderWarning} />
        <View style={styles.collapsedInfo}>
          <View style={styles.collapsedTop}>
            <Text style={[styles.collapsedName, unread && styles.unread]} numberOfLines={1}>
              {from?.name || (from?.email && formatAddress(from.email)) || t('email_viewer.unknown_sender', 'Unknown')}
            </Text>
            {email.hasAttachment && <Paperclip size={12} color={c.textMuted} />}
            <Text style={styles.collapsedDate}>{formatHeaderDate(date, locale)} {formatHeaderTime(date, timeFormat, locale)}</Text>
          </View>
          <Text style={styles.collapsedPreview} numberOfLines={1}>{singleLine(cleanPreview(email.preview))}</Text>
        </View>
        {starred && <Star size={14} color={c.starred} fill={c.starred} />}
      </Pressable>
    );
  }

  // The content keeps its place among the children whether bare or not, so
  // it (and its WebView) is not remounted when a conversation arrives.
  const replyable = replyActions === 'enabled';
  const reply = (mode: 'reply' | 'replyAll' | 'forward') => (replyable ? () => onReply(mode, email) : undefined);
  const actionA11y = {
    accessibilityRole: 'button' as const,
    accessibilityState: { disabled: !replyable },
  };
  return (
    <View style={bare ? (content.fill ? styles.bareFill : undefined) : styles.expanded}>
      {!bare && (
        <Pressable onPress={onToggleExpanded} style={styles.collapseHandle} hitSlop={6} accessibilityLabel={t('threads.collapse', 'Collapse conversation')} />
      )}
      <MessageContent {...content} compact={false} onToggleStar={bare ? undefined : onToggleStar} />
      {!bare && replyActions !== 'hidden' && (
        <View style={[styles.actions, !replyable && styles.actionsDisabled]}>
          <Pressable style={styles.actionBtn} onPress={reply('reply')} disabled={!replyable} hitSlop={6} {...actionA11y}>
            <Reply size={16} color={c.text} />
            <Text style={styles.actionLabel}>{t('email_viewer.reply', 'Reply')}</Text>
          </Pressable>
          <Pressable style={styles.actionBtn} onPress={reply('replyAll')} disabled={!replyable} hitSlop={6} {...actionA11y}>
            <ReplyAll size={16} color={c.text} />
            <Text style={styles.actionLabel}>{t('email_viewer.reply_all', 'Reply All')}</Text>
          </Pressable>
          <Pressable style={styles.actionBtn} onPress={reply('forward')} disabled={!replyable} hitSlop={6} {...actionA11y}>
            <Forward size={16} color={c.text} />
            <Text style={styles.actionLabel}>{t('email_viewer.forward', 'Forward')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/**
 * Stands in for a collapsed card while a conversation's headers load, at the
 * same height, so the opened message does not move when they arrive.
 */
export function ThreadCardPlaceholder() {
  const c = useColors();
  const scaledType = useTypography();
  const styles = React.useMemo(() => makeStyles(c, scaledType), [c, scaledType]);
  return (
    <View style={styles.collapsed}>
      <View style={styles.placeholderAvatar} />
      <View style={styles.collapsedInfo}>
        <Text style={styles.collapsedName}> </Text>
        <Text style={styles.collapsedPreview}> </Text>
      </View>
    </View>
  );
}

function makeStyles(c: ThemePalette, typography: ScaledTypography = tokenTypography) {
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
    bareFill: { flexGrow: 1 },
    placeholderAvatar: {
      width: componentSizes.avatarSm,
      height: componentSizes.avatarSm,
      borderRadius: radius.full,
      backgroundColor: c.surfaceHover,
    },
    actionsDisabled: { opacity: 0.4 },
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
      // Webmail thread card: outline buttons, h-9, rounded-md.
      paddingHorizontal: spacing.md,
      minHeight: 36,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: 'transparent',
    },
    actionLabel: { ...typography.bodyMedium, color: c.text },
  });
}
