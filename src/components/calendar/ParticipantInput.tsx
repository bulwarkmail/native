import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  TextInput,
  ScrollView,
} from 'react-native';
import { X } from '../icons';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useContactsStore, type RecipientSuggestion } from '../../stores/contacts-store';
import { useLocaleStore } from '../../stores/locale-store';
import type { Attendee } from '../../lib/calendar-participants';
import { participantSuggestions, participantsFromSuggestion } from '../../lib/calendar-participant-suggestions';
import { participantRemoveAccessibilityLabel, touchSlop } from '../../lib/calendar-a11y';

/** The cross on a chip: 12 dp drawn, 44 dp to tap. */
const REMOVE_ICON = 12;

interface ParticipantInputProps {
  attendees: Attendee[];
  onAdd: (attendee: Attendee) => void;
  onRemove: (email: string) => void;
}

function emailRegex(): RegExp {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
}

// Attendee rows only: the organizer participant is added by
// buildParticipantMap on save (see lib/calendar-participants).
export function ParticipantInput({ attendees, onAdd, onRemove }: ParticipantInputProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [draft, setDraftState] = React.useState('');
  // Done submits and then blurs the field; both handlers run before a
  // re-render, so they read the text from here, not from `draft`.
  const draftRef = React.useRef('');
  const setDraft = React.useCallback((value: string) => {
    draftRef.current = value;
    setDraftState(value);
  }, []);
  // Contacts, groups and recent Sent recipients, as the composer offers them.
  const getAutocomplete = useContactsStore((s) => s.getAutocomplete);
  const getGroupRecipients = useContactsStore((s) => s.getGroupRecipients);
  const contactsVersion = useContactsStore((s) => s.contacts);
  const recentVersion = useContactsStore((s) => s.recentRecipients);

  const existingEmails = React.useMemo(() => {
    return new Set(attendees.map((a) => a.email.toLowerCase()));
  }, [attendees]);

  const filteredSuggestions = React.useMemo(
    () => participantSuggestions(draft, existingEmails, getAutocomplete, getGroupRecipients),
    // contactsVersion/recentVersion re-run the lookup when the store loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, existingEmails, getAutocomplete, getGroupRecipients, contactsVersion, recentVersion],
  );

  const pickSuggestion = (s: RecipientSuggestion) => {
    for (const person of participantsFromSuggestion(s, existingEmails, getGroupRecipients)) {
      if (emailRegex().test(person.email.trim())) onAdd({ name: person.name, email: person.email.trim() });
    }
    setDraft('');
  };

  const addParticipant = (email: string, name?: string) => {
    const trimmed = email.trim();
    if (!trimmed || !emailRegex().test(trimmed)) return;
    if (existingEmails.has(trimmed.toLowerCase())) {
      setDraft('');
      return;
    }
    onAdd({ name: name || '', email: trimmed });
    setDraft('');
  };

  const handleSubmit = () => {
    const typed = draftRef.current;
    if (typed.trim()) addParticipant(typed);
  };

  return (
    <View style={styles.container}>
      {attendees.length > 0 && (
        <View style={styles.chips}>
          {attendees.map((a) => (
            <View key={a.email.toLowerCase()} style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1}>
                {a.name || a.email}
              </Text>
              <Pressable
                onPress={() => onRemove(a.email)}
                hitSlop={touchSlop(REMOVE_ICON)}
                accessibilityRole="button"
                accessibilityLabel={participantRemoveAccessibilityLabel(a, t)}
              >
                <X size={REMOVE_ICON} color={c.textMuted} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {/* Above the field, not below it: below, the keyboard covered the
          list (the editor keeps only the focused field in view). */}
      {filteredSuggestions.length > 0 && (
        <ScrollView
          style={styles.suggestions}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
          {filteredSuggestions.map((s) => (
            <Pressable
              key={s.group ? `group:${s.group.id}` : s.email}
              style={({ pressed }) => [
                styles.suggestionRow,
                pressed && styles.suggestionRowPressed,
              ]}
              onPress={() => pickSuggestion(s)}
            >
              {!!s.name && <Text style={styles.suggestionName}>{s.name}</Text>}
              <Text style={styles.suggestionEmail}>
                {s.group
                  ? t('calendar.participants.group_members', '{count, plural, one {# member} other {# members}}', { count: s.group.memberCount })
                  : s.email}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <TextInput
        accessibilityLabel={t('calendar.event_modal.participant_placeholder', 'Add participant by email')}
        // No full-screen keyboard in landscape: it would hide the suggestions
        // and the text around the field.
        disableFullscreenUI
        value={draft}
        onChangeText={setDraft}
        placeholder={t('calendar.event_modal.participant_placeholder', 'Add participant by email')}
        placeholderTextColor={c.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        // The app's own suggestions only: system autofill would cover them.
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
        onSubmitEditing={handleSubmit}
        onBlur={handleSubmit}
        returnKeyType="done"
        style={styles.input}
      />
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    maxWidth: '100%',
  },
  chipText: { ...typography.caption, color: c.text, maxWidth: 200 },
  input: {
    height: 40,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    color: c.text,
    ...typography.body,
  },
  suggestions: {
    maxHeight: 180,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    backgroundColor: c.surface,
  },
  suggestionRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
  },
  suggestionRowPressed: { backgroundColor: c.surfaceHover },
  suggestionName: { ...typography.bodyMedium, color: c.text },
  suggestionEmail: { ...typography.caption, color: c.textMuted, marginTop: 1 },
  });
}
