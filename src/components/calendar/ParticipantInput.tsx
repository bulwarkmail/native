import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  TextInput,
  ScrollView,
} from 'react-native';
import { X } from 'lucide-react-native';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useContactsStore } from '../../stores/contacts-store';
import { useLocaleStore } from '../../stores/locale-store';
import type { Attendee } from '../../lib/calendar-participants';

interface ParticipantInputProps {
  attendees: Attendee[];
  onAdd: (attendee: Attendee) => void;
  onRemove: (email: string) => void;
}

interface Suggestion {
  email: string;
  name?: string;
}

function emailRegex(): RegExp {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
}

function flattenContactEmails(): Suggestion[] {
  const contacts = useContactsStore.getState().contacts;
  const out: Suggestion[] = [];
  for (const c of contacts) {
    const name = c.name?.full || undefined;
    if (!c.emails) continue;
    for (const e of Object.values(c.emails)) {
      if (e.address) out.push({ email: e.address, name });
    }
  }
  return out;
}

// Attendee rows only: the organizer participant is added by
// buildParticipantMap on save (see lib/calendar-participants).
export function ParticipantInput({ attendees, onAdd, onRemove }: ParticipantInputProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [draft, setDraft] = React.useState('');
  const [allSuggestions] = React.useState(() => flattenContactEmails());

  const existingEmails = React.useMemo(() => {
    return new Set(attendees.map((a) => a.email.toLowerCase()));
  }, [attendees]);

  const filteredSuggestions = React.useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q || q.length < 2) return [];
    return allSuggestions
      .filter((s) => {
        if (existingEmails.has(s.email.toLowerCase())) return false;
        return (
          s.email.toLowerCase().includes(q) ||
          s.name?.toLowerCase().includes(q)
        );
      })
      .slice(0, 6);
  }, [draft, allSuggestions, existingEmails]);

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
    if (draft.trim()) addParticipant(draft);
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
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={t('calendar.participants.remove', 'Remove')}
              >
                <X size={12} color={c.textMuted} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder={t('calendar.event_modal.participant_placeholder', 'Add participant by email')}
        placeholderTextColor={c.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        onSubmitEditing={handleSubmit}
        onBlur={handleSubmit}
        returnKeyType="done"
        style={styles.input}
      />

      {filteredSuggestions.length > 0 && (
        <ScrollView
          style={styles.suggestions}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
          {filteredSuggestions.map((s) => (
            <Pressable
              key={s.email}
              style={({ pressed }) => [
                styles.suggestionRow,
                pressed && styles.suggestionRowPressed,
              ]}
              onPress={() => addParticipant(s.email, s.name)}
            >
              {s.name && <Text style={styles.suggestionName}>{s.name}</Text>}
              <Text style={styles.suggestionEmail}>{s.email}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
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
