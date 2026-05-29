import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Linking } from 'react-native';
import {
  CalendarPlus, Check, HelpCircle, X, MapPin, Video, Clock, CalendarDays, AlertTriangle,
} from 'lucide-react-native';
import { format, parseISO } from 'date-fns';
import type { Email, CalendarEvent } from '../../api/types';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { parseCalendarBlob } from '../../api/calendar';
import { useCalendarStore } from '../../stores/calendar-store';
import { useAccountStore } from '../../stores/account-store';
import { useSettingsStore } from '../../stores/settings-store';
import {
  findCalendarAttachment,
  findParticipantByEmail,
  getOrganizerName,
  buildReplyTo,
  inferInvitationMethod,
  type InvitationMethod,
} from '../../lib/calendar-invitation';

type BannerState = 'loading' | 'parsed' | 'done' | 'error';
type RsvpStatus = 'accepted' | 'tentative' | 'declined';

interface Props {
  email: Email;
}

export function CalendarInvitationBanner({ email }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const enabled = useSettingsStore((s) => s.calendarInvitationParsingEnabled);
  const calendars = useCalendarStore((s) => s.calendars);
  const importEvents = useCalendarStore((s) => s.importEvents);
  const rsvpEvent = useCalendarStore((s) => s.rsvpEvent);
  const activeEmail = useAccountStore((s) => s.getActiveAccount()?.email ?? null);

  const attachment = React.useMemo(() => findCalendarAttachment(email), [email]);

  const [state, setState] = React.useState<BannerState>('loading');
  const [event, setEvent] = React.useState<Partial<CalendarEvent> | null>(null);
  const [method, setMethod] = React.useState<InvitationMethod>('unknown');
  const [rsvpStatus, setRsvpStatus] = React.useState<RsvpStatus | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    if (!attachment || !enabled) return;
    setState('loading');
    (async () => {
      try {
        const events = await parseCalendarBlob(attachment.blobId);
        if (cancelled) return;
        if (events.length === 0) {
          setState('error');
          return;
        }
        const parsed = events[0];
        setEvent(parsed);
        setMethod(inferInvitationMethod(parsed));
        setState('parsed');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [attachment, enabled]);

  if (!attachment || !enabled || state === 'error') return null;

  if (state === 'loading') {
    return (
      <View style={styles.banner}>
        <ActivityIndicator size="small" color={c.primary} />
        <Text style={styles.loadingText}>Reading invitation…</Text>
      </View>
    );
  }
  if (!event) return null;

  const startStr = event.showWithoutTime ? event.start : (event.utcStart || event.start);
  const startDate = startStr ? parseISO(startStr) : null;
  const dateLabel = startDate && !isNaN(startDate.getTime())
    ? (event.showWithoutTime
        ? format(startDate, 'EEEE, MMM d, yyyy')
        : format(startDate, 'EEE, MMM d · HH:mm'))
    : null;
  const organizer = getOrganizerName(event);
  const location = event.locations ? Object.values(event.locations)[0]?.name : undefined;
  const videoUri = event.virtualLocations ? Object.values(event.virtualLocations)[0]?.uri : undefined;
  const me = activeEmail ? findParticipantByEmail(event, [activeEmail]) : null;
  const canRsvp = method !== 'cancel' && method !== 'reply' && !!me;

  const writableCalendar = calendars.find((cal) => !cal.myRights || cal.myRights.mayWrite !== false);

  const ensureImportedAndRsvp = async (status: RsvpStatus) => {
    if (busy || !writableCalendar) return;
    setBusy(true);
    setNotice(null);
    try {
      // Make sure the event exists in a local calendar (dedupes by UID).
      await importEvents([event], writableCalendar.id);
      // Re-read from the store to get the server-assigned id + participant.
      const stored = useCalendarStore.getState().events.find((e) => e.uid === event.uid);
      const participant = stored && activeEmail
        ? findParticipantByEmail(stored, [activeEmail])
        : me;
      if (stored && participant) {
        await rsvpEvent(stored.id, participant.id, status, buildReplyTo(event));
        setRsvpStatus(status);
        setNotice('Response sent');
      } else {
        setNotice('Added to calendar');
      }
      setState('done');
    } catch {
      setNotice('Could not send your response');
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (busy || !writableCalendar) return;
    setBusy(true);
    setNotice(null);
    try {
      const count = await importEvents([event], writableCalendar.id);
      setNotice(count > 0 ? 'Added to calendar' : 'Already in your calendar');
      setState('done');
    } catch {
      setNotice('Could not add the event');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.banner}>
      <View style={styles.headerRow}>
        <View style={styles.iconBadge}>
          <CalendarDays size={18} color={c.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={2}>{event.title || 'Calendar invitation'}</Text>
          {method === 'cancel' && <Text style={styles.cancelled}>This event was cancelled</Text>}
        </View>
      </View>

      {dateLabel && (
        <Row icon={<Clock size={15} color={c.textMuted} />} text={dateLabel} styles={styles} />
      )}
      {location ? (
        <Row icon={<MapPin size={15} color={c.textMuted} />} text={location} styles={styles} />
      ) : null}
      {videoUri ? (
        <Pressable style={styles.detailRow} onPress={() => { void Linking.openURL(videoUri); }}>
          <Video size={15} color={c.textMuted} />
          <Text style={[styles.detailText, { color: c.primary }]} numberOfLines={1}>Join video call</Text>
        </Pressable>
      ) : null}
      {organizer ? (
        <Row icon={<CalendarPlus size={15} color={c.textMuted} />} text={`Organizer: ${organizer}`} styles={styles} />
      ) : null}

      {notice && <Text style={styles.notice}>{notice}</Text>}

      {state !== 'done' && (
        <View style={styles.actions}>
          {canRsvp ? (
            <>
              <RsvpBtn label="Yes" active={rsvpStatus === 'accepted'} activeColor={c.success}
                icon={<Check size={15} color={rsvpStatus === 'accepted' ? c.textInverse : c.success} />}
                disabled={busy} onPress={() => ensureImportedAndRsvp('accepted')} c={c} styles={styles} />
              <RsvpBtn label="Maybe" active={rsvpStatus === 'tentative'} activeColor={c.warning}
                icon={<HelpCircle size={15} color={rsvpStatus === 'tentative' ? c.textInverse : c.warning} />}
                disabled={busy} onPress={() => ensureImportedAndRsvp('tentative')} c={c} styles={styles} />
              <RsvpBtn label="No" active={rsvpStatus === 'declined'} activeColor={c.error}
                icon={<X size={15} color={rsvpStatus === 'declined' ? c.textInverse : c.error} />}
                disabled={busy} onPress={() => ensureImportedAndRsvp('declined')} c={c} styles={styles} />
            </>
          ) : (
            <Pressable
              style={[styles.importBtn, busy && { opacity: 0.5 }]}
              onPress={() => { void handleImport(); }}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator size="small" color={c.primaryForeground} />
              ) : (
                <CalendarPlus size={16} color={c.primaryForeground} />
              )}
              <Text style={styles.importBtnText}>Add to calendar</Text>
            </Pressable>
          )}
        </View>
      )}

      {!writableCalendar && state !== 'done' && (
        <View style={styles.warnRow}>
          <AlertTriangle size={14} color={c.warning} />
          <Text style={styles.warnText}>No writable calendar available</Text>
        </View>
      )}
    </View>
  );
}

function Row({
  icon, text, styles,
}: {
  icon: React.ReactNode;
  text: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.detailRow}>
      {icon}
      <Text style={styles.detailText} numberOfLines={2}>{text}</Text>
    </View>
  );
}

function RsvpBtn({
  label, icon, active, activeColor, disabled, onPress, c, styles,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  activeColor: string;
  disabled?: boolean;
  onPress: () => void;
  c: ThemePalette;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.rsvpBtn,
        active && { backgroundColor: activeColor, borderColor: activeColor },
        disabled && { opacity: 0.5 },
      ]}
    >
      {icon}
      <Text style={[styles.rsvpBtnText, active && { color: c.textInverse }]}>{label}</Text>
    </Pressable>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    banner: {
      marginHorizontal: spacing.lg,
      marginBottom: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      gap: spacing.xs,
    },
    loadingText: { ...typography.caption, color: c.textMuted },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
    iconBadge: {
      width: 32, height: 32, borderRadius: radius.sm,
      backgroundColor: c.primaryBg, alignItems: 'center', justifyContent: 'center',
    },
    title: { ...typography.bodySemibold, color: c.text },
    cancelled: { ...typography.caption, color: c.error, marginTop: 2 },
    detailRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 2 },
    detailText: { flex: 1, ...typography.caption, color: c.textSecondary },
    notice: { ...typography.captionMedium, color: c.primary, marginTop: spacing.xs },
    actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
    rsvpBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    rsvpBtnText: { ...typography.caption, color: c.text },
    importBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
      backgroundColor: c.primary,
    },
    importBtnText: { ...typography.bodyMedium, color: c.primaryForeground },
    warnRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
    warnText: { ...typography.caption, color: c.warning },
  });
}
