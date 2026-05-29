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
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
  Calendar as CalendarIcon,
  Check,
  ListChecks,
  Plus,
  Trash2,
  X,
} from 'lucide-react-native';
import { format, parseISO } from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { getCalendarColor } from '../../lib/calendar-utils';
import { useSheetDrag } from '../../lib/use-sheet-drag';

interface TasksSheetProps {
  visible: boolean;
  tasks: CalendarEvent[];
  calendars: Calendar[];
  onClose: () => void;
  onCreate: (task: Partial<CalendarEvent>, calendarId: string) => Promise<void> | void;
  onToggle: (id: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
}

function isCompleted(task: CalendarEvent): boolean {
  return task.progress === 'completed';
}

function dueLabel(task: CalendarEvent): string | null {
  if (!task.due) return null;
  const d = parseISO(task.due);
  if (isNaN(d.getTime())) return null;
  return format(d, 'EEE, MMM d');
}

// Tasks first by completion (open first), then by due date (soonest first,
// undated last), then title.
function compareTasks(a: CalendarEvent, b: CalendarEvent): number {
  const ac = isCompleted(a);
  const bc = isCompleted(b);
  if (ac !== bc) return ac ? 1 : -1;
  const ad = a.due ? parseISO(a.due).getTime() : Infinity;
  const bd = b.due ? parseISO(b.due).getTime() : Infinity;
  if (ad !== bd) return ad - bd;
  return (a.title || '').localeCompare(b.title || '');
}

export function TasksSheet({
  visible,
  tasks,
  calendars,
  onClose,
  onCreate,
  onToggle,
  onDelete,
}: TasksSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const slideY = React.useRef(new Animated.Value(Dimensions.get('window').height)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({
    slideY,
    closedY: Dimensions.get('window').height,
    onClose,
  });

  const writableCalendars = React.useMemo(
    () => calendars.filter((cal) => !cal.myRights || cal.myRights.mayWrite !== false),
    [calendars],
  );

  const [title, setTitle] = React.useState('');
  const [calendarId, setCalendarId] = React.useState('');
  const [due, setDue] = React.useState<Date | null>(null);
  const [showDuePicker, setShowDuePicker] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (visible && !calendarId && writableCalendars[0]) {
      setCalendarId(writableCalendars[0].id);
    }
  }, [visible, calendarId, writableCalendars]);

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: Dimensions.get('window').height, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, overlayOpacity]);

  const sorted = React.useMemo(() => [...tasks].sort(compareTasks), [tasks]);

  const handleAdd = async () => {
    const t = title.trim();
    if (!t || !calendarId || saving) return;
    setSaving(true);
    try {
      const task: Partial<CalendarEvent> = {
        title: t,
        progress: 'needs-action',
      };
      if (due) {
        task.due = format(due, "yyyy-MM-dd'T'HH:mm:ss");
      }
      await onCreate(task, calendarId);
      setTitle('');
      setDue(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
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
              <ListChecks size={20} color={c.text} />
              <Text style={styles.headerTitle}>Tasks</Text>
              <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
                <X size={20} color={c.textMuted} />
              </Pressable>
            </View>
          </View>

          <View style={styles.addRow}>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="Add a task…"
              placeholderTextColor={c.textMuted}
              style={styles.addInput}
              returnKeyType="done"
              onSubmitEditing={() => { void handleAdd(); }}
            />
            <Pressable
              onPress={() => setShowDuePicker(true)}
              style={[styles.dueChip, due && styles.dueChipActive]}
              hitSlop={6}
            >
              <CalendarIcon size={14} color={due ? c.primary : c.textMuted} />
              {due && <Text style={styles.dueChipText}>{format(due, 'MMM d')}</Text>}
            </Pressable>
            <Pressable
              onPress={() => { void handleAdd(); }}
              disabled={!title.trim() || !calendarId || saving}
              style={[styles.addBtn, (!title.trim() || saving) && styles.addBtnDisabled]}
            >
              <Plus size={18} color={c.primaryForeground} />
            </Pressable>
          </View>

          {writableCalendars.length > 1 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.calChips}
            >
              {writableCalendars.map((cal) => (
                <Pressable
                  key={cal.id}
                  onPress={() => setCalendarId(cal.id)}
                  style={[styles.calChip, cal.id === calendarId && styles.calChipActive]}
                >
                  <View style={[styles.calSwatch, { backgroundColor: getCalendarColor(cal) }]} />
                  <Text style={styles.calChipText} numberOfLines={1}>{cal.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {sorted.length === 0 ? (
              <View style={styles.empty}>
                <ListChecks size={32} color={c.surfaceActive} />
                <Text style={styles.emptyText}>No tasks yet</Text>
              </View>
            ) : (
              sorted.map((task) => {
                const completed = isCompleted(task);
                const due = dueLabel(task);
                return (
                  <View key={task.id} style={styles.taskRow}>
                    <Pressable
                      onPress={() => { void onToggle(task.id); }}
                      style={[styles.checkbox, completed && styles.checkboxChecked]}
                      hitSlop={8}
                    >
                      {completed && <Check size={14} color={c.primaryForeground} />}
                    </Pressable>
                    <View style={styles.taskText}>
                      <Text style={[styles.taskTitle, completed && styles.taskTitleDone]} numberOfLines={2}>
                        {task.title || 'Untitled task'}
                      </Text>
                      {due && <Text style={styles.taskDue}>{due}</Text>}
                    </View>
                    <Pressable onPress={() => { void onDelete(task.id); }} hitSlop={8} style={styles.taskDelete}>
                      <Trash2 size={16} color={c.textMuted} />
                    </Pressable>
                  </View>
                );
              })
            )}
          </ScrollView>
        </SafeAreaView>
      </Animated.View>

      {showDuePicker && (
        <DateTimePicker
          value={due ?? new Date()}
          mode="date"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={(_, d) => {
            setShowDuePicker(false);
            if (d) setDue(d);
          }}
        />
      )}
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
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
    sheetSafe: { paddingTop: spacing.sm, flexShrink: 1 },
    handleHit: { alignItems: 'center', paddingTop: spacing.xs, paddingBottom: spacing.sm },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.surfaceActive },

    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
    },
    headerTitle: { flex: 1, ...typography.h3, color: c.text },
    closeBtn: { padding: 4 },

    addRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
    },
    addInput: {
      flex: 1,
      ...typography.body,
      color: c.text,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      backgroundColor: c.surface,
    },
    dueChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      height: 38,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    dueChipActive: { borderColor: c.primary, backgroundColor: c.primaryBg },
    dueChipText: { ...typography.caption, color: c.primary },
    addBtn: {
      width: 38,
      height: 38,
      borderRadius: radius.sm,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addBtnDisabled: { opacity: 0.5 },

    calChips: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm },
    calChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: c.border,
      maxWidth: 160,
    },
    calChipActive: { borderColor: c.primary, backgroundColor: c.primaryBg },
    calSwatch: { width: 10, height: 10, borderRadius: 5 },
    calChipText: { ...typography.caption, color: c.text, flexShrink: 1 },

    list: { flexGrow: 0 },
    listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
    empty: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.sm },
    emptyText: { ...typography.body, color: c.textMuted },

    taskRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: radius.xs,
      borderWidth: 2,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxChecked: { backgroundColor: c.primary, borderColor: c.primary },
    taskText: { flex: 1 },
    taskTitle: { ...typography.body, color: c.text },
    taskTitleDone: { textDecorationLine: 'line-through', color: c.textMuted },
    taskDue: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    taskDelete: { padding: 4 },
  });
}
