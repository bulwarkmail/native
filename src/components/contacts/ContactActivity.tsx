import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Mail as MailIcon, CalendarDays } from 'lucide-react-native';
import { format, isAfter, parseISO } from 'date-fns';
import type { ContactCard, Email, CalendarEvent } from '../../api/types';
import type { RootStackParamList } from '../../navigation/types';
import { getEmails, queryEmailsByFilter } from '../../api/email';
import { useCalendarStore } from '../../stores/calendar-store';
import SenderAvatar from '../SenderAvatar';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

const EMAIL_LIMIT = 5;
const EVENT_LIMIT = 5;

type Nav = NativeStackNavigationProp<RootStackParamList>;

function getContactEmails(contact: ContactCard): string[] {
  if (!contact.emails) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of Object.values(contact.emails)) {
    const addr = e.address?.trim().toLowerCase();
    if (addr && !seen.has(addr)) {
      seen.add(addr);
      out.push(addr);
    }
  }
  return out;
}

function buildEmailFilter(addresses: string[]): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [];
  for (const addr of addresses) {
    conditions.push({ from: addr });
    conditions.push({ to: addr });
  }
  if (conditions.length === 1) return conditions[0];
  return { operator: 'OR', conditions };
}

function eventInvolvesContact(event: CalendarEvent, addresses: Set<string>): boolean {
  if (event.participants) {
    for (const p of Object.values(event.participants)) {
      const addr = p.email?.trim().toLowerCase();
      if (addr && addresses.has(addr)) return true;
      if (p.sendTo) {
        for (const target of Object.values(p.sendTo)) {
          const m = typeof target === 'string' ? target.match(/mailto:(.+)/i) : null;
          if (m && addresses.has(m[1].trim().toLowerCase())) return true;
        }
      }
    }
  }
  return false;
}

function formatRelativeDate(iso: string): string {
  try {
    const d = parseISO(iso);
    const now = new Date();
    return d.getFullYear() === now.getFullYear()
      ? format(d, 'MMM d')
      : format(d, 'MMM d, yyyy');
  } catch {
    return '';
  }
}

function formatEventTime(event: CalendarEvent): string {
  if (event.showWithoutTime) return 'All day';
  try {
    return format(parseISO(event.start), 'HH:mm');
  } catch {
    return '';
  }
}

interface Props {
  contact: ContactCard;
}

export function ContactActivity({ contact }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const navigation = useNavigation<Nav>();
  const calendarEvents = useCalendarStore((s) => s.events);

  const addresses = React.useMemo(() => getContactEmails(contact), [contact]);
  const addressKey = addresses.join(',');

  const [emails, setEmails] = React.useState<Email[] | null>(null);
  const [emailsLoading, setEmailsLoading] = React.useState(false);
  const [emailsError, setEmailsError] = React.useState(false);

  React.useEffect(() => {
    if (addresses.length === 0) {
      setEmails([]);
      return;
    }
    let cancelled = false;
    setEmailsLoading(true);
    setEmailsError(false);
    (async () => {
      try {
        const ids = await queryEmailsByFilter(buildEmailFilter(addresses), EMAIL_LIMIT);
        const fetched = ids.length > 0 ? await getEmails(ids) : [];
        if (cancelled) return;
        setEmails(fetched);
      } catch {
        if (cancelled) return;
        setEmailsError(true);
        setEmails([]);
      } finally {
        if (!cancelled) setEmailsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addressKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const upcomingEvents = React.useMemo(() => {
    if (addresses.length === 0) return [];
    const addrSet = new Set(addresses);
    const now = new Date();
    return calendarEvents
      .filter((e) => eventInvolvesContact(e, addrSet))
      .filter((e) => {
        try {
          return isAfter(parseISO(e.utcStart || e.start), now);
        } catch {
          return false;
        }
      })
      .sort((a, b) => (a.utcStart || a.start).localeCompare(b.utcStart || b.start))
      .slice(0, EVENT_LIMIT);
  }, [calendarEvents, addresses]);

  if (addresses.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <MailIcon size={14} color={c.primary} />
          <Text style={styles.sectionTitle}>Recent emails</Text>
        </View>
        {emailsLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator size="small" color={c.primary} />
          </View>
        ) : emailsError ? (
          <Text style={styles.emptyText}>Couldn't load emails.</Text>
        ) : !emails || emails.length === 0 ? (
          <Text style={styles.emptyText}>No emails with this contact.</Text>
        ) : (
          emails.map((email) => {
            const sender = email.from?.[0];
            const senderName = sender?.name || sender?.email || 'Unknown';
            return (
              <Pressable
                key={email.id}
                onPress={() =>
                  navigation.navigate('EmailThread', {
                    emailId: email.id,
                    threadId: email.threadId,
                    subject: email.subject ?? undefined,
                  })
                }
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <SenderAvatar name={senderName} email={sender?.email} size={32} />
                <View style={styles.rowContent}>
                  <View style={styles.rowTop}>
                    <Text style={styles.rowSender} numberOfLines={1}>{senderName}</Text>
                    <Text style={styles.rowDate}>{formatRelativeDate(email.receivedAt)}</Text>
                  </View>
                  <Text style={styles.rowSubject} numberOfLines={1}>
                    {email.subject || '(no subject)'}
                  </Text>
                  {email.preview ? (
                    <Text style={styles.rowPreview} numberOfLines={1}>{email.preview}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })
        )}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <CalendarDays size={14} color={c.primary} />
          <Text style={styles.sectionTitle}>Upcoming events</Text>
        </View>
        {upcomingEvents.length === 0 ? (
          <Text style={styles.emptyText}>No upcoming events.</Text>
        ) : (
          upcomingEvents.map((event) => (
            <View key={event.id} style={styles.eventRow}>
              <Text style={styles.eventTime}>{formatEventTime(event)}</Text>
              <View style={styles.eventInfo}>
                <Text style={styles.eventTitle} numberOfLines={1}>
                  {event.title || '(no title)'}
                </Text>
                <Text style={styles.eventDate}>
                  {formatRelativeDate(event.utcStart || event.start)}
                </Text>
              </View>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  wrap: { gap: spacing.md, paddingHorizontal: spacing.lg, marginBottom: spacing.lg },
  section: {
    backgroundColor: c.card,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderLeftWidth: 3,
    borderLeftColor: c.primary,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  sectionTitle: { ...typography.bodySemibold, color: c.text },
  loading: { paddingVertical: spacing.sm, alignItems: 'flex-start' },
  emptyText: { ...typography.caption, color: c.textMuted },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.xs,
  },
  rowPressed: { backgroundColor: c.surface },
  rowContent: { flex: 1, minWidth: 0 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  rowSender: { ...typography.bodyMedium, color: c.text, flex: 1 },
  rowDate: { ...typography.caption, color: c.textMuted },
  rowSubject: { ...typography.body, color: c.text },
  rowPreview: { ...typography.caption, color: c.textMuted },

  eventRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'baseline', paddingVertical: 4 },
  eventTime: {
    ...typography.caption,
    color: c.textMuted,
    width: 64,
  },
  eventInfo: { flex: 1, minWidth: 0 },
  eventTitle: { ...typography.body, color: c.text },
  eventDate: { ...typography.caption, color: c.textMuted, marginTop: 2 },
  });
}
