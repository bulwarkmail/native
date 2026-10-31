import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme/colors';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { getEmailInitials } from '../../lib/avatar-utils';
import type { MentionCandidate } from '../../lib/recipient-mentions';

/** Rows of the list above the keyboard; a short window gets fewer. */
export function mentionListMaxHeight(shortWindow: boolean): number {
  return (shortWindow ? 2 : 4) * ROW_HEIGHT;
}

const ROW_HEIGHT = 48;

/**
 * Who an "@" in the body can name (webmail RecipientMentionList): the
 * recipients first, then contacts, who picking adds to To. Sits between the
 * body and the format bar, above the keyboard.
 */
export function MentionSuggestionList({
  items, onPick, shortWindow,
}: {
  items: MentionCandidate[];
  onPick: (item: MentionCandidate) => void;
  shortWindow: boolean;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  if (items.length === 0) return null;
  return (
    <View
      style={[styles.box, { maxHeight: mentionListMaxHeight(shortWindow) }]}
      accessibilityLabel={t('email_composer.mention_recipients', 'Recipients')}
    >
      <ScrollView keyboardShouldPersistTaps="always" nestedScrollEnabled>
        {items.map((item) => (
          <Pressable
            key={item.email}
            onPress={() => onPick(item)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            accessibilityRole="button"
            accessibilityLabel={`@${item.label}, ${item.name && item.name !== item.label ? `${item.name}, ` : ''}${item.email}`}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{getEmailInitials((item.name ?? '').trim(), item.email)}</Text>
            </View>
            {/* What goes in comes first: for "Nagy János" that may be the
                surname, which the full name alone would not show. */}
            <Text style={styles.label} numberOfLines={1}>@{item.label}</Text>
            <Text style={styles.detail} numberOfLines={1}>
              {item.name && item.name !== item.label ? `${item.name} · ${item.email}` : item.email}
            </Text>
            {/* Picking a contact also adds them as a recipient; say so first. */}
            {item.addsTo && (
              <Text style={styles.addsTo}>
                + {item.addsTo === 'cc' ? t('email_composer.cc', 'Cc') : t('email_composer.to', 'To')}
              </Text>
            )}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    box: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.borderLight,
      backgroundColor: c.card,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: ROW_HEIGHT,
      paddingHorizontal: spacing.lg,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    avatar: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { ...typography.captionMedium, color: c.primary },
    label: { ...typography.bodyMedium, color: c.text, flexShrink: 0, maxWidth: '45%' },
    detail: { ...typography.caption, color: c.textSecondary, flex: 1 },
    addsTo: {
      ...typography.caption,
      color: c.textSecondary,
      backgroundColor: c.surfaceActive,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      overflow: 'hidden',
    },
  });
}
