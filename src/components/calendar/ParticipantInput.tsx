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
import { colors, radius, spacing, typography } from '../../theme/tokens';
import { useContactsStore } from '../../stores/contacts-store';
import type { Participant } from '../../api/types';

interface ParticipantInputProps {
  participants: Record<string, Participant>;
  onChange: (next: Record<string, Participant>) => void;
}

interface Suggestion {
  email: string;
  name?: string;
}

function emailRegex(): RegExp {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
}

function generateParticipantId(): string {
  return `p-${Math.random().toString(36).slice(2, 10)}`;
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

export function ParticipantInput({ participants, onChange }: ParticipantInputProps) {
  const [draft, setDraft] = React.useState('');
  const [allSuggestions] = React.useState(() => flattenContactEmails());

  const existingEmails = React.useMemo(() => {
    return new Set(Object.values(participants).map((p) => p.email?.toLowerCase()));
  }, [participants]);

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
    const id = generateParticipantId();
    const next: Record<string, Participant> = {
      ...participants,
      [id]: {
        email: trimmed,
        name,
        sendTo: { imip: `mailto:${trimmed}` },
        roles: { attendee: true },
        participationStatus: 'needs-action',
        expectReply: true,
      },
    };
    onChange(next);
    setDraft('');
  };

  const removeParticipant = (id: string) => {
    const next = { ...participants };
    delete next[id];
    onChange(next);
  };

  const handleSubmit = () => {
    if (draft.trim()) addParticipant(draft);
  };

  const entries = Object.entries(participants);

  return (
    <View style={styles.container}>
      {entries.length > 0 && (
        <View style={styles.chips}>
          {entries.map(([id, p]) => (
            <View key={id} style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1}>
                {p.name || p.email || 'Unknown'}
              </Text>
              <Pressable onPress={() => removeParticipant(id)} hitSlop={6}>
                <X size={12} color={colors.textMuted} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="Add participant by email"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        onSubmitEditing={handleSubmit}
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

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    maxWidth: '100%',
  },
  chipText: { ...typography.caption, color: colors.text, maxWidth: 200 },
  input: {
    height: 40,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    color: colors.text,
    ...typography.body,
  },
  suggestions: {
    maxHeight: 180,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  suggestionRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  suggestionRowPressed: { backgroundColor: colors.surfaceHover },
  suggestionName: { ...typography.bodyMedium, color: colors.text },
  suggestionEmail: { ...typography.caption, color: colors.textMuted, marginTop: 1 },
});
