import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useAuthStore } from '../../stores/auth-store';
import type { Attendee } from '../../lib/calendar-participants';
import { attendeeEmails, type AvailabilityStatus } from '../../lib/calendar-free-busy';
import {
  checkAvailabilityAccess,
  knownAvailabilityAccess,
  lookUpAvailabilityStatuses,
  revokeAvailabilityAccess,
  supportsAvailability,
} from '../../api/calendar-availability';

interface ParticipantAvailabilityProps {
  attendees: Attendee[];
  /** The event window as real instants; null while the form has no valid dates. */
  window: { start: Date; end: Date } | null;
}

const STATUS_FALLBACKS: Record<AvailabilityStatus, string> = {
  free: 'Available',
  busy: 'Busy',
  tentative: 'Tentative',
  no_busy_times: 'No busy times shared',
  unknown: 'Not a user on this server',
  error: "Couldn't check",
  checking: 'Checking…',
};

/**
 * Free/busy of the invited attendees for the event window
 * (Principal/getAvailability), as the webmail's
 * components/calendar/participant-availability.tsx shows it. Only attendees
 * that are principals on this server can be checked; external addresses show
 * as unknown. When the server won't answer free/busy for this user, one line
 * says so; nothing is shown when it doesn't offer free/busy at all.
 */
export function ParticipantAvailability({ attendees, window }: ParticipantAvailabilityProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  // Another account or server asks its own question.
  const session = useAuthStore((s) => s.session);
  const supported = !!session && supportsAvailability();
  const [statuses, setStatuses] = React.useState<Record<string, AvailabilityStatus>>({});
  const [access, setAccess] = React.useState<{ session: unknown; allowed: boolean } | null>(null);
  const requestSeq = React.useRef(0);

  const emails = React.useMemo(() => attendeeEmails(attendees), [attendees]);
  const emailsKey = emails.join(',');
  const startMs = window?.start.getTime() ?? null;
  const endMs = window?.end.getTime() ?? null;
  const wanted = supported && emails.length > 0 && startMs !== null && endMs !== null && endMs > startMs;
  // Undefined until the server has said whether it answers free/busy for
  // this user; the block stays hidden until then, so a server that refuses
  // never flashes a list of attendees being checked.
  const allowed = !session ? undefined : access?.session === session ? access.allowed : knownAvailabilityAccess();

  React.useEffect(() => {
    if (!wanted || allowed !== undefined) return;
    let cancelled = false;
    void checkAvailabilityAccess().then((ok) => {
      if (!cancelled) setAccess({ session, allowed: ok });
    });
    return () => {
      cancelled = true;
    };
  }, [session, wanted, allowed]);

  React.useEffect(() => {
    if (!wanted || allowed !== true) {
      setStatuses({});
      return;
    }
    const seq = ++requestSeq.current;
    setStatuses(Object.fromEntries(emails.map((e) => [e, 'checking' as const])));
    // Debounce: changing a time or adding several people must not fire a
    // query per change.
    const timer = setTimeout(async () => {
      const results = await lookUpAvailabilityStatuses(emails, new Date(startMs!), new Date(endMs!));
      if (seq !== requestSeq.current) return;
      if (results === null) {
        revokeAvailabilityAccess();
        setAccess({ session, allowed: false });
        return;
      }
      setStatuses(results);
    }, 400);
    return () => clearTimeout(timer);
    // emailsKey stands in for the emails array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, wanted, allowed, emailsKey, startMs, endMs]);

  if (!wanted) return null;
  if (allowed === false) {
    return (
      <Text style={styles.unavailable} accessibilityRole="text" accessibilityLiveRegion="polite">
        {t('calendar.participants.availability.unavailable_on_server', "Free/busy isn't available on this server")}
      </Text>
    );
  }
  if (allowed !== true) return null;

  return (
    <View
      style={styles.list}
      accessibilityLabel={t('calendar.participants.availability.title', 'Availability')}
    >
      {attendees.map((a) => {
        const status = statuses[a.email.trim().toLowerCase()] ?? 'checking';
        const label = t(`calendar.participants.availability.${status}`, STATUS_FALLBACKS[status]);
        return (
          <View key={a.email} style={styles.row} accessible accessibilityLabel={`${a.name || a.email}: ${label}`}>
            <View style={[styles.dot, { backgroundColor: dotColor(status, c) }]} />
            <Text style={styles.name} numberOfLines={1}>{a.name || a.email}</Text>
            <View style={styles.statusWrap}>
              {status === 'checking' && <ActivityIndicator size="small" color={c.textMuted} style={styles.spinner} />}
              <Text style={styles.status}>{label}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function dotColor(status: AvailabilityStatus, c: ThemePalette): string {
  if (status === 'free') return c.success;
  if (status === 'busy') return c.error;
  if (status === 'tentative') return c.warning;
  return c.border;
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    unavailable: {
      ...typography.caption,
      color: c.textMuted,
      marginTop: spacing.xs,
    },
    list: {
      marginTop: spacing.xs,
      gap: 2,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: 20,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    name: {
      ...typography.caption,
      color: c.text,
      flexShrink: 1,
    },
    statusWrap: {
      marginStart: 'auto',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    spinner: {
      transform: [{ scale: 0.6 }],
    },
    status: {
      ...typography.caption,
      color: c.textMuted,
    },
  });
}
