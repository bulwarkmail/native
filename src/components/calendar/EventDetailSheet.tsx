import React from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  AlignLeft,
  Bell,
  Calendar as CalendarIcon,
  Clock,
  Copy,
  MapPin,
  Pencil,
  Repeat,
  Trash2,
  Users,
  X,
} from 'lucide-react-native';
import { format } from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  eventTimeRange,
  getEventColor,
  getPrimaryCalendarId,
} from '../../lib/calendar-utils';
import { useSheetDrag } from '../../lib/use-sheet-drag';

interface EventDetailSheetProps {
  event: CalendarEvent | null;
  calendars: Calendar[];
  onClose: () => void;
  onEdit?: (event: CalendarEvent) => void;
  onDelete?: (event: CalendarEvent) => void;
  onDuplicate?: (event: CalendarEvent) => void;
}

function formatRange(event: CalendarEvent): string {
  const { start, end, allDay } = eventTimeRange(event);
  if (allDay) {
    if (
      start.getFullYear() === end.getFullYear() &&
      start.getMonth() === end.getMonth() &&
      start.getDate() === end.getDate()
    ) {
      return format(start, 'EEEE, MMM d, yyyy');
    }
    return `${format(start, 'MMM d')} – ${format(end, 'MMM d, yyyy')}`;
  }
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  if (sameDay) {
    return `${format(start, 'EEE, MMM d')} · ${format(start, 'HH:mm')} – ${format(end, 'HH:mm')}`;
  }
  return `${format(start, 'MMM d, HH:mm')} – ${format(end, 'MMM d, HH:mm')}`;
}

function recurrenceLabel(event: CalendarEvent): string | null {
  const rule = event.recurrenceRules?.[0];
  if (!rule) return null;
  const map: Record<string, string> = {
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly',
    yearly: 'Yearly',
  };
  let label = map[rule.frequency] || rule.frequency;
  if (rule.interval && rule.interval > 1) {
    label = `Every ${rule.interval} ${rule.frequency}`;
  }
  if (rule.until) label += ` until ${format(new Date(rule.until), 'MMM d, yyyy')}`;
  else if (rule.count) label += ` for ${rule.count} occurrences`;
  return label;
}

function alertLabel(event: CalendarEvent): string | null {
  if (!event.alerts) return null;
  const first = Object.values(event.alerts)[0];
  if (!first) return null;
  const offset = first.trigger?.offset;
  if (!offset) return null;
  if (offset === 'PT0S' || offset === '-PT0S') return 'At time of event';
  const min = offset.match(/-?PT(\d+)M$/);
  if (min) return `${min[1]} minutes before`;
  const hr = offset.match(/-?PT(\d+)H$/);
  if (hr) return `${hr[1]} hours before`;
  const day = offset.match(/-?P(\d+)D/);
  if (day) return `${day[1]} days before`;
  return null;
}

export function EventDetailSheet({
  event,
  calendars,
  onClose,
  onEdit,
  onDelete,
  onDuplicate,
}: EventDetailSheetProps) {
  const c = useColors();
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
  const range = formatRange(event);
  const recurrence = recurrenceLabel(event);
  const alert = alertLabel(event);
  const participants = event.participants ? Object.values(event.participants) : [];

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
                <Text style={styles.title}>{event.title || 'Untitled'}</Text>
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
            {event.description ? (
              <DetailRow
                icon={<AlignLeft size={16} color={c.textMuted} />}
                text={event.description}
                multiline
              />
            ) : null}
            {recurrence && (
              <DetailRow
                icon={<Repeat size={16} color={c.textMuted} />}
                text={recurrence}
              />
            )}
            {alert && (
              <DetailRow
                icon={<Bell size={16} color={c.textMuted} />}
                text={alert}
              />
            )}
            {calendar && (
              <DetailRow
                icon={<CalendarIcon size={16} color={c.textMuted} />}
                text={calendar.name}
              />
            )}

            {participants.length > 0 && (
              <View style={styles.participantsBlock}>
                <View style={styles.participantsHeader}>
                  <Users size={16} color={c.textMuted} />
                  <Text style={styles.participantsHeaderText}>
                    {participants.length} participants
                  </Text>
                </View>
                {participants.map((p, idx) => (
                  <View key={idx} style={styles.participantRow}>
                    <View
                      style={[
                        styles.participantDot,
                        {
                          backgroundColor: statusColor(c, p.participationStatus),
                        },
                      ]}
                    />
                    <Text style={styles.participantName} numberOfLines={1}>
                      {p.name || p.email || 'Unknown'}
                    </Text>
                    <Text style={styles.participantStatus}>
                      {statusLabel(p.participationStatus)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>

          <View style={styles.actions}>
            {onEdit && (
              <ActionButton
                icon={<Pencil size={18} color={c.text} />}
                label="Edit"
                onPress={() => onEdit(event)}
              />
            )}
            {onDuplicate && (
              <ActionButton
                icon={<Copy size={18} color={c.text} />}
                label="Duplicate"
                onPress={() => onDuplicate(event)}
              />
            )}
            {onDelete && (
              <ActionButton
                icon={<Trash2 size={18} color={c.error} />}
                label="Delete"
                onPress={() => onDelete(event)}
                destructive
              />
            )}
          </View>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

function DetailRow({
  icon,
  text,
  multiline = false,
}: {
  icon: React.ReactNode;
  text: string;
  multiline?: boolean;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailIcon}>{icon}</View>
      <Text style={styles.detailText} numberOfLines={multiline ? undefined : 2}>
        {text}
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

function statusLabel(status?: string): string {
  switch (status) {
    case 'accepted':
      return 'Going';
    case 'declined':
      return 'Declined';
    case 'tentative':
      return 'Maybe';
    case 'needs-action':
      return 'No reply';
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
