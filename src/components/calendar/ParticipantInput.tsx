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
import {
  groupPickAttendees,
  participantQuery,
  participantSuggestions,
  type Attendee,
} from '../../lib/calendar-participants';
import { ownMailboxes } from '../../lib/mailbox-tree';
import type { RecipientSuggestion } from '../../stores/contacts-store';
import { jmapClient } from '../../api/jmap-client';
import { useEmailStore, isShownAccount } from '../../stores/email-store';
import {
  createAvailabilityLoader,
  getPrincipalAvailability,
  loadAttendeeAvailability,
  supportsAvailability,
} from '../../api/availability';
import {
  availabilityRange,
  availabilityStatusLabel,
  everyoneAs,
  principalIdsFromDirectory,
  stripSegments,
} from '../../lib/availability';
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
// each row says "Checking…" while it loads, "Couldn't check availability"
// when the directory or the request failed, and "Not a user on this server"
// only for an address without a principal.
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
    // Everyone is being checked until the answer lands (the debounce included).
    setResults(everyoneAs(emails, 'checking'));
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
        // Waits for a load another caller started, too.
        await useContactsStore.getState().loadDirectory();
        if (!stillHere()) return;
        const principalIdByEmail = principalIdsFromDirectory(useContactsStore.getState(), jmapAccountId);
        if (!principalIdByEmail) {
          // The directory didn't load: nobody could be checked.
          setResults(everyoneAs(emails, 'failed'));
          return;
        }
        const out = await loadAttendeeAvailability({ emails, principalIdByEmail, range, window: win, loader });
        if (stillHere()) setResults(out);
      } catch {
        // Saving is unaffected.
        if (stillHere()) setResults(everyoneAs(emails, 'failed'));
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

function emailRegex(): RegExp {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

  const existingEmails = React.useMemo(() => {
    return new Set(attendees.map((a) => a.email.toLowerCase()));
  }, [attendees]);

  // Re-run the lookup when the store's contacts, recent recipients or
  // directory people load.
  const contactsVersion = useContactsStore((s) => s.contacts);
  const recentVersion = useContactsStore((s) => s.recentRecipients);
  const directoryVersion = useContactsStore((s) => s.directoryPeople);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const sentId = React.useMemo(
    () => ownMailboxes(mailboxes).find((m) => m.role === 'sent')?.id,
    [mailboxes],
  );
  const appAccountId = availabilityAccount?.appAccountId;
  // The store is reset on an account switch: an editor left open across one
  // must not suggest the new account's people.
  const shown = !availabilityAccount || isShownAccount(appAccountId);

  React.useEffect(() => {
    if (shown && sentId) void useContactsStore.getState().loadRecentRecipients(sentId);
  }, [shown, sentId]);
  // Directory people are suggestions too, not only an availability source.
  React.useEffect(() => {
    if (shown) void useContactsStore.getState().loadDirectory();
  }, [shown]);

  const filteredSuggestions = React.useMemo<RecipientSuggestion[]>(() => {
    const q = participantQuery(draft);
    if (!q || !shown) return [];
    return participantSuggestions(useContactsStore.getState().getAutocomplete(q, 16), existingEmails);
    // The versions re-run the lookup when the store loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, shown, existingEmails, contactsVersion, recentVersion, directoryVersion]);

  const pickSuggestion = (s: RecipientSuggestion) => {
    if (!s.group) {
      addParticipant(s.email, s.name);
      return;
    }
    const members = useContactsStore.getState().getGroupRecipients(s.group.id);
    for (const m of groupPickAttendees(members, existingEmails)) onAdd(m);
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
            // Not in the results yet: its check starts with the next run.
            const status: AvailabilityStatus = entry?.status ?? 'checking';
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
                <Text style={styles.availStatus}>{availabilityStatusLabel(status, t)}</Text>
              </View>
            );
          })}
        </View>
      )}

      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder={t('calendar.participants.email_placeholder', 'Add email address or search contacts')}
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
              key={s.group ? `group:${s.group.id}` : s.email}
              style={({ pressed }) => [
                styles.suggestionRow,
                pressed && styles.suggestionRowPressed,
              ]}
              onPress={() => pickSuggestion(s)}
            >
              {s.name && <Text style={styles.suggestionName}>{s.name}</Text>}
              <Text style={styles.suggestionEmail}>
                {s.group
                  ? t('contacts.groups.member_count', '{count, plural, =0 {No members} one {1 member} other {# members}}', { count: s.group.memberCount })
                  : s.email}
              </Text>
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
