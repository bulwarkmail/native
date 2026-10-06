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
import { jmapClient } from '../../api/jmap-client';
import { useEmailStore, isShownAccount } from '../../stores/email-store';
import {
  createAvailabilityLoader,
  getPrincipalAvailability,
  loadAttendeeAvailability,
  supportsAvailability,
} from '../../api/availability';
import { availabilityRange, stripSegments } from '../../lib/availability';
import type { AvailabilityStatus, BusyBlock } from '../../lib/availability';

/** The account the editor opened in; free/busy is asked for it only. */
export interface AvailabilityAccount {
  jmapAccountId: string;
  appAccountId: string | null | undefined;
}

/** The event's time window; null while the form has no valid one. */
export interface AvailabilityWindow {
  start: Date;
  end: Date;
}

const AVAILABILITY_DEBOUNCE_MS = 500;

type AttendeeAvailability = { status: AvailabilityStatus; blocks: BusyBlock[] };

// Free/busy of the attendees over the event window. It never gates saving:
// loading, failure and "not on this server" all read as unknown.
function useAttendeeAvailability(
  attendees: Attendee[],
  account: AvailabilityAccount | undefined,
  window: AvailabilityWindow | null,
): Record<string, AttendeeAvailability> {
  const [results, setResults] = React.useState<Record<string, AttendeeAvailability>>({});
  const jmapAccountId = account?.jmapAccountId ?? '';
  const appAccountId = account?.appAccountId;
  const supported = !!account && !!jmapAccountId && supportsAvailability();
  const emailsKey = attendees.map((a) => a.email.trim().toLowerCase()).filter(Boolean).sort().join(',');
  const startMs = window?.start.getTime() ?? null;
  const endMs = window?.end.getTime() ?? null;

  // One cache per open editor and account: at most one request per
  // participant and range while it is open.
  const loader = React.useMemo(() => {
    void jmapAccountId;
    void appAccountId;
    return createAvailabilityLoader(async (principalId, range) =>
      getPrincipalAvailability({ accountId: jmapAccountId, principalId, ...range, gen: jmapClient.connectionGen }),
    );
  }, [jmapAccountId, appAccountId]);

  React.useEffect(() => {
    const emails = emailsKey ? emailsKey.split(',') : [];
    const win = startMs !== null && endMs !== null ? { start: new Date(startMs), end: new Date(endMs) } : null;
    const range = win ? availabilityRange(win.start, win.end) : null;
    if (!supported || emails.length === 0 || !win || !range) {
      setResults({});
      return;
    }
    let cancelled = false;
    // Still the account the editor opened in, on the connection it opened on.
    const stillHere = () => {
      try {
        return !cancelled && jmapClient.accountId === jmapAccountId && isShownAccount(appAccountId);
      } catch {
        return false;
      }
    };
    const timer = setTimeout(async () => {
      try {
        if (!stillHere()) return;
        const contacts = useContactsStore.getState();
        if (contacts.directoryAccountId !== jmapAccountId) await contacts.loadDirectory();
        if (!stillHere()) return;
        const loaded = useContactsStore.getState();
        const people = loaded.directoryAccountId === jmapAccountId ? loaded.directoryPeople : [];
        const principalIdByEmail = new Map<string, string>();
        for (const p of people) {
          if (p.principalId) principalIdByEmail.set(p.email.toLowerCase(), p.principalId);
        }
        const out = await loadAttendeeAvailability({ emails, principalIdByEmail, range, window: win, loader });
        if (stillHere()) setResults(out);
      } catch {
        // Unknown for everyone; saving is unaffected.
        if (stillHere()) setResults({});
      }
    }, AVAILABILITY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [supported, emailsKey, startMs, endMs, jmapAccountId, appAccountId, loader]);

  return supported && window ? results : NO_RESULTS;
}

const NO_RESULTS: Record<string, AttendeeAvailability> = {};

interface ParticipantInputProps {
  attendees: Attendee[];
  onAdd: (attendee: Attendee) => void;
  onRemove: (email: string) => void;
  /** Present while the editor is open; omitted, no availability is asked. */
  availabilityAccount?: AvailabilityAccount;
  window?: AvailabilityWindow | null;
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
export function ParticipantInput({ attendees, onAdd, onRemove, availabilityAccount, window = null }: ParticipantInputProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [draft, setDraft] = React.useState('');
  const availability = useAttendeeAvailability(attendees, availabilityAccount, window);
  const showAvailability = !!availabilityAccount && !!window && attendees.length > 0 && supportsAvailability();
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

      {showAvailability && window && (
        <View accessibilityLabel={t('calendar.participants.availability.title', 'Availability')} style={styles.availability}>
          {attendees.map((a) => {
            const entry = availability[a.email.trim().toLowerCase()];
            const status: AvailabilityStatus = entry?.status ?? 'unknown';
            const segments = entry ? stripSegments(entry.blocks, window.start, window.end) : [];
            const dot =
              status === 'free' ? c.success
              : status === 'busy' ? c.error
              : status === 'tentative' ? c.warning
              : c.textMuted;
            return (
              <View key={a.email.toLowerCase()} style={styles.availRow}>
                <View style={[styles.availDot, { backgroundColor: dot }]} />
                <Text style={styles.availName} numberOfLines={1}>{a.name || a.email}</Text>
                <View style={styles.strip}>
                  {segments.map((seg, i) => (
                    <View
                      key={i}
                      style={[
                        styles.stripBlock,
                        {
                          left: `${seg.left * 100}%`,
                          width: `${seg.width * 100}%`,
                          backgroundColor: seg.tentative ? c.warning : c.error,
                        },
                      ]}
                    />
                  ))}
                </View>
                <Text style={styles.availStatus}>
                  {status === 'free' ? t('calendar.participants.availability.free', 'Available')
                    : status === 'busy' ? t('calendar.participants.availability.busy', 'Busy')
                    : status === 'tentative' ? t('calendar.participants.availability.tentative', 'Tentative')
                    : t('calendar.participants.availability.unknown', 'Not a user on this server')}
                </Text>
              </View>
            );
          })}
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
  availability: { gap: 4 },
  availRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  availDot: { width: 8, height: 8, borderRadius: 4 },
  availName: { ...typography.caption, color: c.text, flexShrink: 1, maxWidth: 140 },
  strip: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.borderLight,
    overflow: 'hidden',
  },
  stripBlock: { position: 'absolute', top: 0, bottom: 0 },
  availStatus: { ...typography.caption, color: c.textMuted },
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
