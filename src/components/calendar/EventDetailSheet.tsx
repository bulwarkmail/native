import React from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { openExternalUrl } from '../../lib/open-url';
import { splitTextLinks } from '../../lib/linkify-text';
import { findMeetingLink, locationAction, mapsUrl, primaryLocationName } from '../../lib/event-links';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  AlignLeft,
  Bell,
  Calendar as CalendarIcon,
  Check,
  Clock,
  Copy,
  HelpCircle,
  MapPin,
  Link2,
  Pencil,
  Repeat,
  Share2,
  Trash2,
  Users,
  Video,
  X,
} from 'lucide-react-native';
import { format, type Locale } from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  eventTimeRange,
  getEventColor,
  getEventDisplayEndDate,
  getPrimaryCalendarId,
  timePattern,
  type TimeFormat,
} from '../../lib/calendar-utils';
import { alertsToReminders, formatReminder } from '../../lib/calendar-alerts';
import {
  getParticipantList,
  getUserParticipantId,
  isOrganizer,
} from '../../lib/calendar-participants';
import { getEventEditability } from '../../lib/calendar-editability';
import { useCalendarLocale } from '../../lib/calendar-locale';
import { useSheetDrag } from '../../lib/use-sheet-drag';

type RsvpStatus = 'accepted' | 'declined' | 'tentative';

interface EventDetailSheetProps {
  event: CalendarEvent | null;
  calendars: Calendar[];
  timeFormat?: TimeFormat;
  // Login address + identities + aliases; finds "me" among the participants.
  currentUserEmails?: string[];
  // Client-side iCal subscriptions are always read-only.
  isSubscriptionCalendar?: (calendarId: string) => boolean;
  onClose: () => void;
  onEdit?: (event: CalendarEvent) => void;
  onDelete?: (event: CalendarEvent) => void;
  onDuplicate?: (event: CalendarEvent) => void;
  onExport?: (event: CalendarEvent) => void;
  // Copy the meeting link; only offered when the event has one.
  onCopyLink?: (event: CalendarEvent, link: string) => void;
  onRsvp?: (event: CalendarEvent, participantId: string, status: RsvpStatus) => void | Promise<void>;
}

function formatRange(event: CalendarEvent, timeFormat: TimeFormat | undefined, locale: Locale): string {
  const { start, allDay } = eventTimeRange(event);
  // All-day events store an exclusive end (next day 00:00); show the
  // inclusive last day so a one-day event doesn't read as two (#318).
  const end = allDay ? getEventDisplayEndDate(event) : eventTimeRange(event).end;
  const opts = { locale };
  if (allDay) {
    if (
      start.getFullYear() === end.getFullYear() &&
      start.getMonth() === end.getMonth() &&
      start.getDate() === end.getDate()
    ) {
      return format(start, 'EEEE, MMM d, yyyy', opts);
    }
    return `${format(start, 'MMM d', opts)} – ${format(end, 'MMM d, yyyy', opts)}`;
  }
  const tp = timePattern(timeFormat);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  if (sameDay) {
    return `${format(start, 'EEE, MMM d', opts)} · ${format(start, tp, opts)} – ${format(end, tp, opts)}`;
  }
  return `${format(start, `MMM d, ${tp}`, opts)} – ${format(end, `MMM d, ${tp}`, opts)}`;
}

type Translate = (key: string, fallback?: string) => string;

function recurrenceLabel(event: CalendarEvent, t: Translate, locale: Locale): string | null {
  const rule = event.recurrenceRules?.[0];
  if (!rule) return null;
  const freq = rule.frequency.toLowerCase();
  const unitKey: Record<string, [string, string]> = {
    daily: ['calendar.recurrence.every_n_days', 'Every {count} days'],
    weekly: ['calendar.recurrence.every_n_weeks', 'Every {count} weeks'],
    monthly: ['calendar.recurrence.every_n_months', 'Every {count} months'],
    yearly: ['calendar.recurrence.every_n_years', 'Every {count} years'],
  };
  let label: string;
  if (rule.interval && rule.interval > 1 && unitKey[freq]) {
    label = t(unitKey[freq][0], unitKey[freq][1]).replace('{count}', String(rule.interval));
  } else {
    label = t(`calendar.recurrence.${freq}`, rule.frequency);
  }
  if (rule.until) {
    label += ` · ${t('calendar.recurrence.until', 'Until')} ${format(new Date(rule.until), 'MMM d, yyyy', { locale })}`;
  } else if (rule.count) {
    label += ` · ${t('calendar.recurrence.occurrences', '{count} occurrences').replace('{count}', String(rule.count))}`;
  }
  return label;
}

export function EventDetailSheet({
  event,
  calendars,
  timeFormat,
  currentUserEmails = [],
  isSubscriptionCalendar,
  onClose,
  onEdit,
  onDelete,
  onDuplicate,
  onExport,
  onCopyLink,
  onRsvp,
}: EventDetailSheetProps) {
  const c = useColors();
  const { locale, t } = useCalendarLocale();
  const [rsvpBusy, setRsvpBusy] = React.useState(false);
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const slideY = React.useRef(new Animated.Value(Dimensions.get('window').height)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const visible = !!event;
  const dragHandlers = useSheetDrag({
    slideY,
    closedY: Dimensions.get('window').height,
    onClose,
  });

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideY, {
          toValue: 0,
          duration: 240,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(overlayOpacity, {
          toValue: 1,
          duration: 240,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, {
          toValue: Dimensions.get('window').height,
          duration: 200,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(overlayOpacity, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, slideY, overlayOpacity]);

  if (!event) return null;

  const color = getEventColor(event, calendars);
  const calendarId = getPrimaryCalendarId(event);
  const calendar = calendars.find((c) => c.id === calendarId);
  const range = formatRange(event, timeFormat, locale);
  const recurrence = recurrenceLabel(event, t, locale);
  const reminders = alertsToReminders(event.alerts);
  const participants = getParticipantList(event);
  const location = primaryLocationName(event);
  // Invitations (Teams above all) leave virtualLocations empty and bury the
  // join URL in the description; surface it as the meeting link anyway.
  const meeting = findMeetingLink(event);
  const videoUri = meeting?.uri;
  const isCancelled = event.status === 'cancelled';

  // Can the signed-in user RSVP? Only when they appear as a non-organizer
  // participant (matched against every address of theirs: login, identities,
  // aliases) and the caller wired an onRsvp handler.
  const myParticipantId = getUserParticipantId(event, currentUserEmails);
  const userIsOrganizer = isOrganizer(event, currentUserEmails);
  // Gate affordances on calendar rights first, then identity: read-only /
  // subscription calendars never offer Edit/Delete, RSVP-only events offer
  // just the reply buttons.
  const editability = getEventEditability(event, {
    calendarsById: new Map(calendars.map((cal) => [cal.id, cal])),
    userCalendarAddresses: currentUserEmails,
    isSubscriptionCalendar: isSubscriptionCalendar ?? (() => false),
  });
  const canEdit = editability === 'editable';
  const canRsvp = Boolean(
    onRsvp && myParticipantId && !userIsOrganizer && editability !== 'read-only',
  );
  const myStatus = myParticipantId ? event.participants?.[myParticipantId]?.participationStatus : undefined;

  const openLocation = () => {
    if (!location) return;
    const action = locationAction(location, meeting);
    if (action.kind === 'url') {
      void openExternalUrl(action.uri, { confirm: true });
    } else {
      void openExternalUrl(mapsUrl(action.query, Platform.OS));
    }
  };

  const copyLocation = () => {
    if (!location) return;
    void Clipboard.setStringAsync(location).then(() => {
      if (Platform.OS === 'android') {
        ToastAndroid.show(t('notifications.copied_to_clipboard', 'Copied to clipboard'), ToastAndroid.SHORT);
      }
    }).catch(() => {});
  };

  const doRsvp = async (status: RsvpStatus) => {
    if (!onRsvp || !myParticipantId || rsvpBusy) return;
    setRsvpBusy(true);
    try {
      await onRsvp(event, myParticipantId, status);
    } finally {
      setRsvpBusy(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={styles.overlayPress} onPress={onClose} />
      </Animated.View>

      <Animated.View style={[styles.sheet, { transform: [{ translateY: slideY }] }]}>
        <SafeAreaView edges={['bottom']} style={styles.sheetSafe}>
          <View {...dragHandlers}>
            <View style={styles.handleHit}>
              <View style={styles.handle} />
            </View>

            <View style={styles.header}>
              <View style={[styles.colorBar, { backgroundColor: color }]} />
              <View style={styles.headerText}>
                <Text style={[styles.title, isCancelled && styles.titleCancelled]}>
                  {event.title || t('calendar.events.no_title', '(No title)')}
                </Text>
                {calendar && <Text style={styles.subtitle}>{calendar.name}</Text>}
              </View>
              <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
                <X size={20} color={c.textMuted} />
              </Pressable>
            </View>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            showsVerticalScrollIndicator={false}
          >
            <DetailRow icon={<Clock size={16} color={c.textMuted} />} text={range} />
            {location ? (
              <View style={styles.detailRow}>
                <View style={styles.detailIcon}>
                  <MapPin size={16} color={c.textMuted} />
                </View>
                <Text
                  style={[styles.detailText, styles.detailLink]}
                  numberOfLines={3}
                  onPress={openLocation}
                  onLongPress={copyLocation}
                  accessibilityRole="link"
                  accessibilityHint={t('calendar.detail.location_hint', 'Opens the location; long-press to copy it')}
                >
                  {location}
                </Text>
              </View>
            ) : null}
            {videoUri ? (
              <View style={styles.detailRow}>
                <View style={styles.detailIcon}>
                  <Video size={16} color={c.textMuted} />
                </View>
                <Pressable
                  style={styles.joinBtn}
                  onPress={() => { void openExternalUrl(videoUri, { confirm: true }); }}
                >
                  <Text style={styles.joinBtnText}>
                    {t('calendar.detail.open_link', 'Open link')}
                    {meeting?.provider ? ` · ${meeting.provider}` : ''}
                  </Text>
                </Pressable>
              </View>
            ) : null}
            {event.description ? (
              <DetailRow
                icon={<AlignLeft size={16} color={c.textMuted} />}
                text={event.description}
                multiline
                linkify
              />
            ) : null}
            {recurrence && (
              <DetailRow
                icon={<Repeat size={16} color={c.textMuted} />}
                text={recurrence}
              />
            )}
            {reminders.length > 0 && (
              <DetailRow
                icon={<Bell size={16} color={c.textMuted} />}
                text={reminders.map((r) => formatReminder(r.minutesBefore, t)).join(', ')}
              />
            )}
            {calendar && (
              <DetailRow
                icon={<CalendarIcon size={16} color={c.textMuted} />}
                text={calendar.name}
              />
            )}

            {canRsvp && (
              <View style={styles.rsvpBlock}>
                <Text style={styles.rsvpPrompt}>{t('calendar.participants.rsvp_label', 'Your response')}</Text>
                <View style={styles.rsvpButtons}>
                  <RsvpButton
                    label={t('calendar.participants.accepted', 'Accepted')}
                    icon={<Check size={16} color={myStatus === 'accepted' ? c.textInverse : c.success} />}
                    active={myStatus === 'accepted'}
                    activeColor={c.success}
                    disabled={rsvpBusy}
                    onPress={() => doRsvp('accepted')}
                  />
                  <RsvpButton
                    label={t('calendar.participants.tentative', 'Tentative')}
                    icon={<HelpCircle size={16} color={myStatus === 'tentative' ? c.textInverse : c.warning} />}
                    active={myStatus === 'tentative'}
                    activeColor={c.warning}
                    disabled={rsvpBusy}
                    onPress={() => doRsvp('tentative')}
                  />
                  <RsvpButton
                    label={t('calendar.participants.declined', 'Declined')}
                    icon={<X size={16} color={myStatus === 'declined' ? c.textInverse : c.error} />}
                    active={myStatus === 'declined'}
                    activeColor={c.error}
                    disabled={rsvpBusy}
                    onPress={() => doRsvp('declined')}
                  />
                </View>
              </View>
            )}

            {participants.length > 0 && (
              <View style={styles.participantsBlock}>
                <View style={styles.participantsHeader}>
                  <Users size={16} color={c.textMuted} />
                  <Text style={styles.participantsHeaderText}>
                    {participants.length} {t('calendar.participants.title', 'Participants').toLowerCase()}
                  </Text>
                </View>
                {participants.map((p) => (
                  <View key={p.id} style={styles.participantRow}>
                    <View
                      style={[
                        styles.participantDot,
                        {
                          backgroundColor: statusColor(c, p.status),
                        },
                      ]}
                    />
                    <Text style={styles.participantName} numberOfLines={1}>
                      {p.name || p.email || 'Unknown'}
                      {p.isOrganizer ? (
                        <Text style={styles.participantOrganizer}>
                          {' '}({t('calendar.participants.organizer', 'Organizer').toLowerCase()})
                        </Text>
                      ) : null}
                    </Text>
                    <Text style={styles.participantStatus}>
                      {p.isOrganizer ? '' : statusLabel(p.status, t)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>

          {(canEdit || onDuplicate || onExport || (onCopyLink && videoUri)) && (
            <View style={styles.actions}>
              {onEdit && canEdit && (
                <ActionButton
                  icon={<Pencil size={18} color={c.text} />}
                  label={t('calendar.participants.edit', 'Edit')}
                  onPress={() => onEdit(event)}
                />
              )}
              {onDuplicate && (
                <ActionButton
                  icon={<Copy size={18} color={c.text} />}
                  label={t('calendar.events.duplicate', 'Duplicate')}
                  onPress={() => onDuplicate(event)}
                />
              )}
              {onExport && (
                <ActionButton
                  icon={<Share2 size={18} color={c.text} />}
                  label={t('calendar.events.export_ics_short', '.ics')}
                  onPress={() => onExport(event)}
                />
              )}
              {onCopyLink && videoUri && (
                <ActionButton
                  icon={<Link2 size={18} color={c.text} />}
                  label={t('calendar.events.copy_link_short', 'Link')}
                  onPress={() => onCopyLink(event, videoUri)}
                />
              )}
              {onDelete && canEdit && (
                <ActionButton
                  icon={<Trash2 size={18} color={c.error} />}
                  label={t('calendar.management.delete', 'Delete')}
                  onPress={() => onDelete(event)}
                  destructive
                />
              )}
            </View>
          )}
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

function DetailRow({
  icon,
  text,
  multiline = false,
  linkify = false,
}: {
  icon: React.ReactNode;
  text: string;
  multiline?: boolean;
  /**
   * Render the http(s) URLs inside `text` as tappable links. For rows whose
   * text comes from the invitation itself - a meeting description carries the
   * join URL - never for text the app composed.
   */
  linkify?: boolean;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const segments = React.useMemo(() => (linkify ? splitTextLinks(text) : null), [linkify, text]);
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailIcon}>{icon}</View>
      <Text style={styles.detailText} numberOfLines={multiline ? undefined : 2}>
        {segments
          ? segments.map((segment, i) => (segment.url ? (
            <Text
              key={i}
              style={styles.detailLink}
              onPress={() => { void openExternalUrl(segment.url as string, { confirm: true }); }}
            >
              {segment.text}
            </Text>
          ) : (
            <Text key={i}>{segment.text}</Text>
          )))
          : text}
      </Text>
    </View>
  );
}

function ActionButton({
  icon,
  label,
  onPress,
  destructive = false,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionBtn,
        pressed && styles.actionBtnPressed,
      ]}
    >
      {icon}
      <Text style={[styles.actionLabel, destructive && styles.actionLabelDestructive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function RsvpButton({
  label,
  icon,
  active,
  activeColor,
  disabled,
  onPress,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  activeColor: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
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

function statusColor(c: ThemePalette, status?: string): string {
  switch (status) {
    case 'accepted':
      return c.success;
    case 'declined':
      return c.error;
    case 'tentative':
      return c.warning;
    default:
      return c.textMuted;
  }
}

function statusLabel(status: string | undefined, t: Translate): string {
  switch (status) {
    case 'accepted':
      return t('calendar.participants.accepted', 'Accepted');
    case 'declined':
      return t('calendar.participants.declined', 'Declined');
    case 'tentative':
      return t('calendar.participants.tentative', 'Tentative');
    case 'needs-action':
      return t('calendar.participants.needs_action', 'Needs action');
    default:
      return status || '';
  }
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  overlayPress: { flex: 1 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '85%',
    backgroundColor: c.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  sheetSafe: { paddingTop: spacing.sm },
  handleHit: {
    alignItems: 'center',
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.surfaceActive,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  colorBar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  headerText: { flex: 1 },
  title: { ...typography.h3, color: c.text },
  titleCancelled: { textDecorationLine: 'line-through', color: c.textMuted },
  subtitle: { ...typography.caption, color: c.textMuted, marginTop: 2 },
  closeBtn: { padding: 4 },

  body: { maxHeight: 400 },
  bodyContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  detailRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  detailIcon: { width: 16, paddingTop: 2 },
  detailText: { flex: 1, ...typography.body, color: c.text },
  detailLink: { color: c.primary, textDecorationLine: 'underline' },

  joinBtn: {
    flex: 1,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: c.primaryBg,
  },
  joinBtnText: { ...typography.bodyMedium, color: c.primary },

  rsvpBlock: { gap: spacing.sm, marginTop: spacing.xs },
  rsvpPrompt: { ...typography.bodyMedium, color: c.text },
  rsvpButtons: { flexDirection: 'row', gap: spacing.sm },
  rsvpBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  rsvpBtnText: { ...typography.caption, color: c.text },

  participantsBlock: {
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  participantsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.xs,
  },
  participantsHeaderText: { ...typography.bodyMedium, color: c.text },
  participantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 4,
  },
  participantDot: { width: 8, height: 8, borderRadius: 4 },
  participantName: { flex: 1, ...typography.body, color: c.text },
  participantOrganizer: { ...typography.caption, color: c.textMuted },
  participantStatus: { ...typography.caption, color: c.textMuted },

  actions: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    gap: 4,
    borderRadius: radius.sm,
  },
  actionBtnPressed: { backgroundColor: c.surfaceHover },
  actionLabel: { ...typography.caption, color: c.text },
  actionLabelDestructive: { color: c.error },
  });
}
