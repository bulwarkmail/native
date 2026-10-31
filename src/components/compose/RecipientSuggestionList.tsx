import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Search, Users, X } from '../icons';
import { useColors } from '../../theme/colors';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { getEmailInitials } from '../../lib/avatar-utils';
import { SUGGESTION_ROW_HEIGHT } from '../../lib/recipient-picker';
import type { RecipientSuggestion } from '../../stores/contacts-store';

/** A recipient chip's data. Group chips carry their resolved members and no email. */
export interface ChipRecipient {
  name?: string;
  email: string;
  group?: { members: Array<{ name?: string; email: string }> };
}

export function RecipientChip({
  recipient, invalid, onRemove, onLongPress,
}: {
  recipient: ChipRecipient;
  invalid?: boolean;
  onRemove: () => void;
  onLongPress?: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const label = recipient.group
    ? t('email_composer.group_chip', '{name} ({count})', {
      name: recipient.name || t('contacts.group', 'Group'),
      count: recipient.group.members.length,
    })
    : recipient.name || recipient.email;
  return (
    <Pressable onLongPress={onLongPress} delayLongPress={350} style={[styles.chip, invalid && styles.chipInvalid]}>
      {recipient.group && <Users size={12} color={c.textSecondary} />}
      <Text style={[styles.chipText, invalid && styles.chipTextInvalid]} numberOfLines={1}>
        {label}
      </Text>
      <Pressable
        onPress={onRemove}
        // A 12 px icon: the touch area reaches about 40 dp around it.
        hitSlop={14}
        accessibilityRole="button"
        accessibilityLabel={t('email_composer.recipient_remove', 'Remove')}
      >
        <X size={12} color={invalid ? c.error : c.textMuted} />
      </Pressable>
    </Pressable>
  );
}

/**
 * The contact suggestions for the address being typed. Inline it drops down
 * under the field; `fill` makes it the body of the full-screen recipient
 * picker, where it takes the room above the keyboard.
 */
export function RecipientSuggestionList({
  suggestions, onPick, onPressIn, onSearchServer, searchingServer, fill = false,
}: {
  suggestions: RecipientSuggestion[];
  onPick: (s: RecipientSuggestion) => void;
  onPressIn?: () => void;
  /** Search the Sent folder on the server for more (webmail: "Search the server"). */
  onSearchServer?: () => void;
  searchingServer?: boolean;
  fill?: boolean;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  return (
    <View style={fill ? styles.fillBox : styles.suggestionBox}>
      <ScrollView
        style={fill ? styles.fillScroll : styles.suggestionScroll}
        keyboardShouldPersistTaps="always"
        nestedScrollEnabled
      >
      {suggestions.map((s, i) => (
        <Pressable
          key={`${s.group?.id ?? s.email}-${i}`}
          onPressIn={onPressIn}
          onPress={() => onPick(s)}
          style={({ pressed }) => [styles.suggestionRow, pressed && styles.suggestionRowPressed]}
        >
          <View style={styles.suggestionAvatar}>
            {s.group
              ? <Users size={14} color={c.primary} />
              : <Text style={styles.suggestionAvatarText}>{getEmailInitials(s.name.trim(), s.email)}</Text>}
          </View>
          <View style={styles.suggestionText}>
            <Text style={styles.suggestionName} numberOfLines={1}>
              {s.name || s.email}
            </Text>
            {s.group ? (
              <Text style={styles.suggestionEmail} numberOfLines={1}>
                {t('contacts.groups.member_count', '{count, plural, =0 {No members} one {1 member} other {# members}}', { count: s.group.memberCount })}
              </Text>
            ) : !!s.name && (
              <Text style={styles.suggestionEmail} numberOfLines={1}>{s.email}</Text>
            )}
          </View>
        </Pressable>
      ))}
      {onSearchServer && (
        <Pressable
          onPressIn={onPressIn}
          onPress={() => { if (!searchingServer) onSearchServer(); }}
          disabled={searchingServer}
          accessibilityRole="button"
          accessibilityState={{ busy: !!searchingServer, disabled: !!searchingServer }}
          style={({ pressed }) => [
            styles.suggestionRow,
            suggestions.length > 0 && styles.suggestionSearchRowDivided,
            pressed && styles.suggestionRowPressed,
          ]}
        >
          <View style={styles.suggestionSearchIcon}>
            {searchingServer
              ? <ActivityIndicator size="small" color={c.textSecondary} />
              : <Search size={16} color={c.textSecondary} />}
          </View>
          <Text style={styles.suggestionSearchText} numberOfLines={1}>
            {searchingServer
              ? t('email_composer.autocomplete_searching', 'Searching...')
              : t('email_composer.autocomplete_search_server', 'Search the server')}
          </Text>
        </Pressable>
      )}
      </ScrollView>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.full,
      backgroundColor: c.surfaceActive,
      maxWidth: 220,
    },
    chipInvalid: { backgroundColor: c.errorBg, borderWidth: 1, borderColor: c.error },
    chipText: { ...typography.caption, color: c.text, flexShrink: 1 },
    chipTextInvalid: { color: c.error },
    suggestionBox: {
      position: 'absolute',
      top: '100%',
      left: spacing.lg + 56 + spacing.md,
      right: spacing.lg,
      borderWidth: 1,
      borderColor: c.borderLight,
      borderRadius: radius.sm,
      backgroundColor: c.card,
      zIndex: 20,
      elevation: 5,
      overflow: 'hidden',
    },
    fillBox: { flex: 1, backgroundColor: c.background },
    suggestionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      minHeight: SUGGESTION_ROW_HEIGHT,
      gap: spacing.sm,
    },
    suggestionRowPressed: { backgroundColor: c.surfaceHover },
    suggestionScroll: { maxHeight: 320 },
    fillScroll: { flex: 1 },
    suggestionSearchRowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.borderLight },
    suggestionSearchIcon: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    suggestionSearchText: { ...typography.body, color: c.textSecondary, flex: 1 },
    suggestionAvatar: {
      width: 32, height: 32,
      borderRadius: 16,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    suggestionAvatarText: { ...typography.captionMedium, color: c.primary },
    suggestionText: { flex: 1 },
    suggestionName: { ...typography.bodyMedium, color: c.text },
    suggestionEmail: { ...typography.caption, color: c.textSecondary },
  });
}
