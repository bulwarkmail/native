import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { openExternalUrl } from '../../lib/open-url';
import {
  CalendarPlus, Check, HelpCircle, X, MapPin, Video, Clock, CalendarDays, AlertTriangle,
  ShieldCheck, ShieldAlert, ChevronDown,
} from 'lucide-react-native';
import { format, parseISO } from 'date-fns';
import type { Calendar, Email, CalendarEvent } from '../../api/types';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { fetchCalendarBlobText, findEventsByUid, parseCalendarBlob } from '../../api/calendar';
import { useCalendarStore } from '../../stores/calendar-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import {
  calendarInvitationKey,
  findCalendarAttachment,
  findParticipantByEmail,
  getInvitationMethod,
  getInvitationTrustAssessment,
  getOrganizerName,
  buildReplyTo,
  type InvitationMethod,
  type InvitationTrustAssessment,
} from '../../lib/calendar-invitation';
import { useUserCalendarAddresses } from '../../lib/calendar-user-addresses';
import { canCreateEventsIn } from '../../lib/calendar-editability';
import { getCalendarColor, timePattern } from '../../lib/calendar-utils';
import { useCalendarSubscriptionsStore } from '../../stores/calendar-subscriptions-store';

type BannerState = 'loading' | 'parsed' | 'done' | 'error';
type RsvpStatus = 'accepted' | 'tentative' | 'declined';

interface Props {
  email: Email;
  // Account the email lives in (a shared mailbox's owner); the .ics blob is
  // parsed against it. Undefined for the user's own mailboxes.
  jmapAccountId?: string;
}

// Literal t() calls so the keys are harvested into the catalog.
function trustReasonText(
  reason: NonNullable<InvitationTrustAssessment['reason']>,
  t: (key: string, fallback?: string) => string,
): string {
  switch (reason) {
    case 'sender_mismatch_unverified':
      return t(
        'calendar.invitation.trust_sender_mismatch_unverified',
        'The sender does not match the organizer and the message is not authenticated.',
      );
    case 'authentication_failed':
      return t('calendar.invitation.trust_authentication_failed', 'This message failed sender authentication (SPF/DKIM/DMARC).');
    case 'sender_mismatch':
      return t('calendar.invitation.trust_sender_mismatch', 'The sender differs from the event organizer.');
    case 'authentication_missing':
      return t('calendar.invitation.trust_authentication_missing', 'The sender could not be verified.');
  }
}

export function CalendarInvitationBanner({ email, jmapAccountId }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const enabled = useSettingsStore((s) => s.calendarInvitationParsingEnabled);
  const timeFormat = useSettingsStore((s) => s.calendarTimeFormat);
  const calendars = useCalendarStore((s) => s.calendars);
  const storeEvents = useCalendarStore((s) => s.events);
  const subscriptions = useCalendarSubscriptionsStore((s) => s.subscriptions);
  const importEvents = useCalendarStore((s) => s.importEvents);
  const rsvpEvent = useCalendarStore((s) => s.rsvpEvent);
  const attachment = React.useMemo(() => findCalendarAttachment(email), [email]);
  // Login address + identities + aliases, so invitations addressed to an
  // alias still show the RSVP buttons. Only an invitation looks the aliases up.
  const currentUserEmails = useUserCalendarAddresses(!!attachment && enabled);
  // The invitation is loaded once per message, account and calendar part;
  // a mark-read or star hands a new `email` for the same one.
  const invitationKey = calendarInvitationKey(email, attachment, jmapAccountId);
  const latest = React.useRef({ email, attachment });
  latest.current = { email, attachment };

  const [state, setState] = React.useState<BannerState>('loading');
  const [event, setEvent] = React.useState<Partial<CalendarEvent> | null>(null);
  // The invitation's event as found on the server by UID, for one outside
  // the calendar's loaded window.
  const [serverMatch, setServerMatch] = React.useState<CalendarEvent | null>(null);
  const [method, setMethod] = React.useState<InvitationMethod>('unknown');
  const [rsvpStatus, setRsvpStatus] = React.useState<RsvpStatus | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [calendarId, setCalendarId] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const { email: current, attachment: part } = latest.current;
    if (!invitationKey || !part || !enabled) return;
    setState('loading');
    setServerMatch(null);
    (async () => {
      try {
        const events = await parseCalendarBlob(part.blobId, jmapAccountId);
        if (cancelled) return;
        if (events.length === 0) {
          setState('error');
          return;
        }
        const parsed = events[0];
        setEvent(parsed);
        // The store only holds the calendar's loaded window; look the event
        // up on the server so one already there counts as existing and the
        // RSVP goes to it. Best-effort, must not block the banner.
        if (parsed.uid && !useCalendarStore.getState().events.some((e) => e.uid === parsed.uid)) {
          findEventsByUid(parsed.uid)
            .then((found) => { if (!cancelled && found[0]) setServerMatch(found[0]); })
            .catch(() => undefined);
        }
        // Explicit method (Content-Type params) first; JMAP usually strips
        // them, so fall back to the raw ICS METHOD line before guessing.
        let detected = getInvitationMethod(parsed, { email: current, attachment: part });
        if (detected === 'unknown') {
          const raw = await fetchCalendarBlobText(part.blobId, jmapAccountId);
          if (cancelled) return;
          detected = getInvitationMethod(parsed, { email: current, attachment: part, rawIcs: raw });
        }
        setMethod(detected);
        setState('parsed');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [invitationKey, enabled, jmapAccountId]);

  // Import into the account's default calendar; never into a shared calendar,
  // an iCal subscription (the next feed sync would delete the event) or a
  // read-only one. The user can still pick another writable calendar.
  const candidates = React.useMemo(() => {
    const isSubscriptionCalendar = (id: string) => subscriptions.some((s) => s.calendarId === id);
    return calendars.filter((cal) => !cal.isShared && canCreateEventsIn(cal, isSubscriptionCalendar));
  }, [calendars, subscriptions]);
  const targetCalendar: Calendar | undefined =
    candidates.find((cal) => cal.id === calendarId)
    ?? candidates.find((cal) => cal.isDefault)
    ?? candidates[0];

  // Already imported? Look for the UID among the loaded events, then among
  // what the server lookup found.
  const existing = React.useMemo(() => {
    if (!event?.uid) return null;
    return storeEvents.find((e) => e.uid === event.uid) ?? serverMatch;
  }, [storeEvents, event?.uid, serverMatch]);

  const trust = React.useMemo(
    () => (event ? getInvitationTrustAssessment(event, email, method) : null),
    [event, email, method],
  );

  if (!attachment || !enabled || state === 'error') return null;

  if (state === 'loading') {
    return (
      <View style={styles.banner}>
        <ActivityIndicator size="small" color={c.primary} />
        <Text style={styles.loadingText}>{t('calendar.invitation.reading', 'Reading invitation…')}</Text>
      </View>
    );
  }
  if (!event) return null;

  const startStr = event.showWithoutTime ? event.start : (event.utcStart || event.start);
  const startDate = startStr ? parseISO(startStr) : null;
  const dateLabel = startDate && !isNaN(startDate.getTime())
    ? (event.showWithoutTime
        ? format(startDate, 'EEEE, MMM d, yyyy')
        : format(startDate, `EEE, MMM d · ${timePattern(timeFormat)}`))
    : null;
  const organizer = getOrganizerName(event);
  const location = event.locations ? Object.values(event.locations)[0]?.name : undefined;
  const videoUri = event.virtualLocations ? Object.values(event.virtualLocations)[0]?.uri : undefined;
  const me = findParticipantByEmail(existing ?? event, currentUserEmails);
  const canRsvp = method !== 'cancel' && method !== 'reply' && !!me;
  const myExistingStatus = existing && me ? existing.participants?.[me.id]?.participationStatus : undefined;
  const currentStatus: RsvpStatus | null =
    rsvpStatus
    ?? (myExistingStatus === 'accepted' || myExistingStatus === 'tentative' || myExistingStatus === 'declined'
      ? myExistingStatus
      : null);

  const ensureImportedAndRsvp = async (status: RsvpStatus) => {
    if (busy || !targetCalendar) return;
    setBusy(true);
    setNotice(null);
    try {
      let target = existing;
      if (!target) {
        // Make sure the event exists in a local calendar (dedupes by UID),
        // then find it on the server for its id and participant: the store
        // never sees an event outside the loaded window.
        await importEvents([event], targetCalendar.id);
        target = event.uid ? (await findEventsByUid(event.uid))[0] ?? null : null;
        if (target) setServerMatch(target);
      }
      const participant = target ? findParticipantByEmail(target, currentUserEmails) : null;
      // Never claim success when no response went out.
      if (!target || !participant) throw new Error('No event to respond to');
      await rsvpEvent(target.id, participant.id, status, buildReplyTo(event), target);
      setRsvpStatus(status);
      setNotice(t('calendar.invitation.response_sent', 'Response sent'));
      setState('done');
    } catch {
      setNotice(t('calendar.invitation.response_error', 'Could not send your response'));
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (busy || !targetCalendar) return;
    setBusy(true);
    setNotice(null);
    try {
      const { imported } = await importEvents([event], targetCalendar.id);
      setNotice(
        imported > 0
          ? t('calendar.invitation.added', 'Added to calendar')
          : t('calendar.invitation.already_in_calendar', 'Already in your calendar'),
      );
      setState('done');
    } catch {
      setNotice(t('calendar.invitation.add_error', 'Could not add the event'));
    } finally {
      setBusy(false);
    }
  };

  const trustColor = trust?.level === 'warning' ? c.error : trust?.level === 'caution' ? c.warning : c.success;

  return (
    <View style={[styles.banner, trust?.level === 'warning' && styles.bannerWarning]}>
      <View style={styles.headerRow}>
        <View style={styles.iconBadge}>
          <CalendarDays size={18} color={c.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={2}>
            {event.title || t('calendar.invitation.title', 'Calendar invitation')}
          </Text>
          {method === 'cancel' && (
            <Text style={styles.cancelled}>{t('calendar.invitation.cancelled', 'This event was cancelled')}</Text>
          )}
          {method === 'reply' && (
            <Text style={styles.subtitle}>{t('calendar.invitation.reply', 'A participant replied to this invitation')}</Text>
          )}
        </View>
      </View>

      {trust && (
        <View style={[styles.trustRow, { borderColor: trustColor }]}>
          {trust.level === 'trusted' ? (
            <ShieldCheck size={14} color={trustColor} />
          ) : (
            <ShieldAlert size={14} color={trustColor} />
          )}
          <Text style={[styles.trustText, { color: trustColor }]} numberOfLines={3}>
            {trust.reason
              ? trustReasonText(trust.reason, t)
              : t('calendar.invitation.trust_verified', 'Sender verified')}
          </Text>
        </View>
      )}

      {dateLabel && (
        <Row icon={<Clock size={15} color={c.textMuted} />} text={dateLabel} styles={styles} />
      )}
      {location ? (
        <Row icon={<MapPin size={15} color={c.textMuted} />} text={location} styles={styles} />
      ) : null}
      {videoUri ? (
        <Pressable style={styles.detailRow} onPress={() => { void openExternalUrl(videoUri, { confirm: true }); }}>
          <Video size={15} color={c.textMuted} />
          <Text style={[styles.detailText, { color: c.primary }]} numberOfLines={1}>
            {t('calendar.invitation.join_video', 'Join video call')}
          </Text>
        </Pressable>
      ) : null}
      {organizer ? (
        <Row
          icon={<CalendarPlus size={15} color={c.textMuted} />}
          text={t('email_viewer.calendar_invitation.organizer', 'Organized by {name}', { name: organizer })}
          styles={styles}
        />
      ) : null}
      {existing && state !== 'done' && (
        <Row
          icon={<Check size={15} color={c.success} />}
          text={t('calendar.invitation.already_in_calendar', 'Already in your calendar')}
          styles={styles}
        />
      )}

      {state !== 'done' && !existing && targetCalendar && candidates.length > 1 && (
        <View>
          <Pressable style={styles.calendarPicker} onPress={() => setPickerOpen((v) => !v)}>
            <View style={[styles.calendarSwatch, { backgroundColor: getCalendarColor(targetCalendar) }]} />
            <Text style={styles.calendarPickerText} numberOfLines={1}>{targetCalendar.name}</Text>
            <ChevronDown size={14} color={c.textMuted} />
          </Pressable>
          {pickerOpen && (
            <View style={styles.calendarList}>
              {candidates.map((cal) => (
                <Pressable
                  key={cal.id}
                  style={[styles.calendarRow, cal.id === targetCalendar.id && styles.calendarRowActive]}
                  onPress={() => { setCalendarId(cal.id); setPickerOpen(false); }}
                >
                  <View style={[styles.calendarSwatch, { backgroundColor: getCalendarColor(cal) }]} />
                  <Text style={styles.calendarPickerText} numberOfLines={1}>{cal.name}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      )}

      {notice && <Text style={styles.notice}>{notice}</Text>}

      {state !== 'done' && (
        <View style={styles.actions}>
          {canRsvp ? (
            <>
              <RsvpBtn label={t('calendar.invitation.accept', 'Yes')} active={currentStatus === 'accepted'} activeColor={c.success}
                icon={<Check size={15} color={currentStatus === 'accepted' ? c.textInverse : c.success} />}
                disabled={busy} onPress={() => ensureImportedAndRsvp('accepted')} c={c} styles={styles} />
              <RsvpBtn label={t('calendar.invitation.tentative', 'Maybe')} active={currentStatus === 'tentative'} activeColor={c.warning}
                icon={<HelpCircle size={15} color={currentStatus === 'tentative' ? c.textInverse : c.warning} />}
                disabled={busy} onPress={() => ensureImportedAndRsvp('tentative')} c={c} styles={styles} />
              <RsvpBtn label={t('calendar.invitation.decline', 'No')} active={currentStatus === 'declined'} activeColor={c.error}
                icon={<X size={15} color={currentStatus === 'declined' ? c.textInverse : c.error} />}
                disabled={busy} onPress={() => ensureImportedAndRsvp('declined')} c={c} styles={styles} />
            </>
          ) : !existing && method !== 'reply' ? (
            <Pressable
              style={[styles.importBtn, (busy || !targetCalendar) && { opacity: 0.5 }]}
              onPress={() => { void handleImport(); }}
              disabled={busy || !targetCalendar}
            >
              {busy ? (
                <ActivityIndicator size="small" color={c.primaryForeground} />
              ) : (
                <CalendarPlus size={16} color={c.primaryForeground} />
              )}
              <Text style={styles.importBtnText}>{t('calendar.invitation.add_to_calendar', 'Add to calendar')}</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {!targetCalendar && state !== 'done' && (
        <View style={styles.warnRow}>
          <AlertTriangle size={14} color={c.warning} />
          <Text style={styles.warnText}>{t('calendar.invitation.no_writable_calendar', 'No writable calendar available')}</Text>
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
    bannerWarning: { borderColor: c.errorBorder, backgroundColor: c.errorBg },
    loadingText: { ...typography.caption, color: c.textMuted },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
    iconBadge: {
      width: 32, height: 32, borderRadius: radius.sm,
      backgroundColor: c.primaryBg, alignItems: 'center', justifyContent: 'center',
    },
    title: { ...typography.bodySemibold, color: c.text },
    subtitle: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    cancelled: { ...typography.caption, color: c.error, marginTop: 2 },
    trustRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.sm,
      borderWidth: 1,
      marginBottom: spacing.xs,
    },
    trustText: { ...typography.caption, flex: 1 },
    detailRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 2 },
    detailText: { flex: 1, ...typography.caption, color: c.textSecondary },
    calendarPicker: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
      marginTop: spacing.xs,
    },
    calendarPickerText: { ...typography.caption, color: c.text, flex: 1 },
    calendarSwatch: { width: 10, height: 10, borderRadius: 5 },
    calendarList: {
      marginTop: 4,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.background,
      overflow: 'hidden',
    },
    calendarRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    calendarRowActive: { backgroundColor: c.primaryBg },
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
