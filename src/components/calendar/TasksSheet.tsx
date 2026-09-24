import React from 'react';
import {
  Alert,
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
  Clock,
  Flag,
  ListChecks,
  Plus,
  Trash2,
  X,
} from 'lucide-react-native';
import { format, isBefore, isToday, startOfDay } from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { getCalendarColor, getTaskDueDate, timePattern, type TimeFormat } from '../../lib/calendar-utils';
import {
  emptyTaskEditor,
  priorityToLevel,
  submitTaskEditor,
  taskEditorFromTask,
  type PriorityLevel,
  type TaskEditorState,
} from '../../lib/task-editor';
import { isWritableCalendar } from '../../lib/calendar-editability';
import { useCalendarLocale } from '../../lib/calendar-locale';
import { useSheetDrag } from '../../lib/use-sheet-drag';

type TaskFilter = 'all' | 'pending' | 'completed' | 'overdue';

interface TasksSheetProps {
  visible: boolean;
  tasks: CalendarEvent[];
  calendars: Calendar[];
  timeFormat?: TimeFormat;
  // Task to open in the editor when the sheet appears (from a calendar chip).
  initialTaskId?: string | null;
  onClose: () => void;
  onCreate: (task: Partial<CalendarEvent>, calendarId: string) => Promise<void> | void;
  onUpdate?: (id: string, changes: Partial<CalendarEvent>) => Promise<void> | void;
  onToggle: (id: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
}

function isCompleted(task: CalendarEvent): boolean {
  return task.progress === 'completed' || task.progress === 'cancelled';
}

function isOverdue(task: CalendarEvent): boolean {
  if (isCompleted(task)) return false;
  const d = getTaskDueDate(task);
  if (!d) return false;
  return isBefore(d, startOfDay(new Date())) && !isToday(d);
}

// Open tasks first, overdue first among them, then by due date (soonest
// first, undated last), then by priority, then title.
function compareTasks(a: CalendarEvent, b: CalendarEvent): number {
  const ac = isCompleted(a);
  const bc = isCompleted(b);
  if (ac !== bc) return ac ? 1 : -1;
  const ao = isOverdue(a);
  const bo = isOverdue(b);
  if (ao !== bo) return ao ? -1 : 1;
  const ad = getTaskDueDate(a)?.getTime() ?? Infinity;
  const bd = getTaskDueDate(b)?.getTime() ?? Infinity;
  if (ad !== bd) return ad - bd;
  const ap = a.priority || 10;
  const bp = b.priority || 10;
  if (ap !== bp) return ap - bp;
  return (a.title || '').localeCompare(b.title || '');
}

export function TasksSheet({
  visible,
  tasks,
  calendars,
  timeFormat,
  initialTaskId,
  onClose,
  onCreate,
  onUpdate,
  onToggle,
  onDelete,
}: TasksSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { locale, t } = useCalendarLocale();
  const slideY = React.useRef(new Animated.Value(Dimensions.get('window').height)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({
    slideY,
    closedY: Dimensions.get('window').height,
    onClose,
  });

  const writableCalendars = React.useMemo(
    () => calendars.filter((cal) => isWritableCalendar(cal)),
    [calendars],
  );
  const defaultCalendarId = writableCalendars[0]?.id || '';

  const [filter, setFilter] = React.useState<TaskFilter>('all');
  const [editor, setEditor] = React.useState<TaskEditorState>(() => emptyTaskEditor(defaultCalendarId));
  const [expanded, setExpanded] = React.useState(false);
  const [showDatePicker, setShowDatePicker] = React.useState(false);
  const [showTimePicker, setShowTimePicker] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!visible) return;
    const initial = initialTaskId ? tasks.find((task) => task.id === initialTaskId) : undefined;
    if (initial) {
      setEditor(taskEditorFromTask(initial, defaultCalendarId));
      setExpanded(true);
    } else {
      setEditor(emptyTaskEditor(defaultCalendarId));
      setExpanded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialTaskId]);

  React.useEffect(() => {
    if (visible && !editor.calendarId && defaultCalendarId) {
      setEditor((e) => ({ ...e, calendarId: defaultCalendarId }));
    }
  }, [visible, editor.calendarId, defaultCalendarId]);

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

  const filtered = React.useMemo(() => {
    let result = tasks;
    switch (filter) {
      case 'pending':
        result = result.filter((task) => !isCompleted(task));
        break;
      case 'completed':
        result = result.filter((task) => task.progress === 'completed');
        break;
      case 'overdue':
        result = result.filter(isOverdue);
        break;
    }
    return [...result].sort(compareTasks);
  }, [tasks, filter]);

  const counts = React.useMemo(() => ({
    all: tasks.length,
    pending: tasks.filter((task) => !isCompleted(task)).length,
    completed: tasks.filter((task) => task.progress === 'completed').length,
    overdue: tasks.filter(isOverdue).length,
  }), [tasks]);

  const resetEditor = () => {
    setEditor(emptyTaskEditor(defaultCalendarId));
    setExpanded(false);
  };

  const handleSave = async () => {
    if (!editor.title.trim() || !editor.calendarId || saving) return;
    setSaving(true);
    try {
      const result = await submitTaskEditor(editor, tasks, { onCreate, onUpdate });
      if (result.ok) {
        resetEditor();
      } else {
        // Keep the editor as it is so the user can fix it or try again.
        Alert.alert(t('calendar.tasks.save_error', 'Failed to save task'), result.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const dueLabel = (task: CalendarEvent): string | null => {
    const d = getTaskDueDate(task);
    if (!d || !task.due) return null;
    const hasTime = !task.showWithoutTime && !/^\d{4}-\d{2}-\d{2}$/.test(task.due);
    return hasTime
      ? format(d, `EEE, MMM d · ${timePattern(timeFormat)}`, { locale })
      : format(d, 'EEE, MMM d', { locale });
  };

  const priorityColor = (level: PriorityLevel): string =>
    level === 'high' ? c.error : level === 'medium' ? c.warning : level === 'low' ? c.primary : c.textMuted;

  const FILTERS: { value: TaskFilter; key: string; fallback: string }[] = [
    { value: 'all', key: 'calendar.tasks.filter_all', fallback: 'All' },
    { value: 'pending', key: 'calendar.tasks.filter_pending', fallback: 'Pending' },
    { value: 'completed', key: 'calendar.tasks.filter_completed', fallback: 'Completed' },
    { value: 'overdue', key: 'calendar.tasks.filter_overdue', fallback: 'Overdue' },
  ];
  const PRIORITIES: { value: PriorityLevel; key: string; fallback: string }[] = [
    { value: 'none', key: 'calendar.tasks.priority_none', fallback: 'None' },
    { value: 'high', key: 'calendar.tasks.priority_high', fallback: 'High' },
    { value: 'medium', key: 'calendar.tasks.priority_medium', fallback: 'Medium' },
    { value: 'low', key: 'calendar.tasks.priority_low', fallback: 'Low' },
  ];

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
              <Text style={styles.headerTitle}>{t('calendar.tasks.label', 'Tasks')}</Text>
              <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
                <X size={20} color={c.textMuted} />
              </Pressable>
            </View>
          </View>

          <View style={styles.addRow}>
            <TextInput
              value={editor.title}
              onChangeText={(v) => setEditor((e) => ({ ...e, title: v }))}
              placeholder={editor.id ? t('calendar.tasks.title_placeholder', 'Task title') : t('calendar.tasks.add_placeholder', 'Add a task…')}
              placeholderTextColor={c.textMuted}
              style={styles.addInput}
              returnKeyType="done"
              onFocus={() => setExpanded(true)}
              onSubmitEditing={() => { void handleSave(); }}
            />
            <Pressable
              onPress={() => { void handleSave(); }}
              disabled={!editor.title.trim() || !editor.calendarId || saving}
              style={[styles.addBtn, (!editor.title.trim() || saving) && styles.addBtnDisabled]}
            >
              {editor.id ? <Check size={18} color={c.primaryForeground} /> : <Plus size={18} color={c.primaryForeground} />}
            </Pressable>
          </View>

          {expanded && (
            <View style={styles.editor}>
              <TextInput
                value={editor.description}
                onChangeText={(v) => setEditor((e) => ({ ...e, description: v }))}
                placeholder={t('calendar.tasks.description_placeholder', 'Notes')}
                placeholderTextColor={c.textMuted}
                style={styles.descriptionInput}
                multiline
              />
              <View style={styles.editorRow}>
                <Pressable
                  onPress={() => setShowDatePicker(true)}
                  style={[styles.chip, editor.due && styles.chipActive]}
                >
                  <CalendarIcon size={14} color={editor.due ? c.primary : c.textMuted} />
                  <Text style={[styles.chipText, editor.due && styles.chipTextActive]}>
                    {editor.due ? format(editor.due, 'MMM d', { locale }) : t('calendar.tasks.due_date', 'Due date')}
                  </Text>
                  {editor.due && (
                    <Pressable
                      hitSlop={6}
                      onPress={() => setEditor((e) => ({ ...e, due: null, withTime: false }))}
                    >
                      <X size={12} color={c.textMuted} />
                    </Pressable>
                  )}
                </Pressable>
                {editor.due && (
                  <Pressable
                    onPress={() => setShowTimePicker(true)}
                    style={[styles.chip, editor.withTime && styles.chipActive]}
                  >
                    <Clock size={14} color={editor.withTime ? c.primary : c.textMuted} />
                    <Text style={[styles.chipText, editor.withTime && styles.chipTextActive]}>
                      {editor.withTime
                        ? format(editor.due, timePattern(timeFormat), { locale })
                        : t('calendar.tasks.add_time', 'Add time')}
                    </Text>
                  </Pressable>
                )}
              </View>
              <View style={styles.editorRow}>
                <Flag size={14} color={c.textMuted} />
                {PRIORITIES.map((p) => {
                  const active = editor.priority === p.value;
                  return (
                    <Pressable
                      key={p.value}
                      onPress={() => setEditor((e) => ({ ...e, priority: p.value }))}
                      style={[styles.chip, active && { borderColor: priorityColor(p.value), backgroundColor: c.surface }]}
                    >
                      <Text style={[styles.chipText, active && { color: priorityColor(p.value) }]}>
                        {t(p.key, p.fallback)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {writableCalendars.length > 1 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.calChips}>
                  {writableCalendars.map((cal) => (
                    <Pressable
                      key={cal.id}
                      onPress={() => setEditor((e) => ({ ...e, calendarId: cal.id }))}
                      style={[styles.calChip, cal.id === editor.calendarId && styles.calChipActive]}
                    >
                      <View style={[styles.calSwatch, { backgroundColor: getCalendarColor(cal) }]} />
                      <Text style={styles.calChipText} numberOfLines={1}>{cal.name}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              )}
              {editor.id && (
                <Pressable onPress={resetEditor} style={styles.cancelEdit}>
                  <Text style={styles.cancelEditText}>{t('calendar.form.cancel', 'Cancel')}</Text>
                </Pressable>
              )}
            </View>
          )}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
            {FILTERS.map((f) => {
              const active = filter === f.value;
              return (
                <Pressable
                  key={f.value}
                  onPress={() => setFilter(f.value)}
                  style={[styles.filterChip, active && styles.filterChipActive]}
                >
                  <Text style={[styles.filterText, active && styles.filterTextActive]}>
                    {t(f.key, f.fallback)} · {counts[f.value]}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {filtered.length === 0 ? (
              <View style={styles.empty}>
                <ListChecks size={32} color={c.surfaceActive} />
                <Text style={styles.emptyText}>{t('calendar.tasks.no_tasks', 'No tasks')}</Text>
              </View>
            ) : (
              filtered.map((task) => {
                const completed = isCompleted(task);
                const overdue = isOverdue(task);
                const due = dueLabel(task);
                const level = priorityToLevel(task.priority);
                return (
                  <View key={task.id} style={[styles.taskRow, editor.id === task.id && styles.taskRowEditing]}>
                    <Pressable
                      onPress={() => { void onToggle(task.id); }}
                      style={[styles.checkbox, completed && styles.checkboxChecked]}
                      hitSlop={8}
                    >
                      {completed && <Check size={14} color={c.primaryForeground} />}
                    </Pressable>
                    <Pressable
                      style={styles.taskText}
                      onPress={() => {
                        if (!onUpdate) return;
                        setEditor(taskEditorFromTask(task, defaultCalendarId));
                        setExpanded(true);
                      }}
                    >
                      <View style={styles.taskTitleRow}>
                        {level !== 'none' && <Flag size={12} color={priorityColor(level)} />}
                        <Text style={[styles.taskTitle, completed && styles.taskTitleDone]} numberOfLines={2}>
                          {task.title || t('calendar.tasks.no_title', '(No title)')}
                        </Text>
                      </View>
                      {task.description ? (
                        <Text style={styles.taskDescription} numberOfLines={1}>{task.description}</Text>
                      ) : null}
                      {due && (
                        <Text style={[styles.taskDue, overdue && styles.taskDueOverdue]}>{due}</Text>
                      )}
                    </Pressable>
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

      {showDatePicker && (
        <DateTimePicker
          value={editor.due ?? new Date()}
          mode="date"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={(_, d) => {
            setShowDatePicker(false);
            if (d) {
              setEditor((e) => {
                const next = new Date(e.due ?? d);
                next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
                if (!e.withTime) next.setHours(0, 0, 0, 0);
                return { ...e, due: next };
              });
            }
          }}
        />
      )}
      {showTimePicker && (
        <DateTimePicker
          value={editor.due ?? new Date()}
          mode="time"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={(_, d) => {
            setShowTimePicker(false);
            if (d) {
              setEditor((e) => {
                const next = new Date(e.due ?? d);
                next.setHours(d.getHours(), d.getMinutes(), 0, 0);
                return { ...e, due: next, withTime: true };
              });
            }
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
      maxHeight: '88%',
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
    addBtn: {
      width: 38,
      height: 38,
      borderRadius: radius.sm,
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addBtnDisabled: { opacity: 0.5 },

    editor: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm },
    descriptionInput: {
      ...typography.body,
      color: c.text,
      minHeight: 48,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      backgroundColor: c.surface,
      textAlignVertical: 'top',
    },
    editorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    chipActive: { borderColor: c.primary, backgroundColor: c.primaryBg },
    chipText: { ...typography.caption, color: c.textMuted },
    chipTextActive: { color: c.primary },
    cancelEdit: { alignSelf: 'flex-end', paddingVertical: 4 },
    cancelEditText: { ...typography.caption, color: c.primary },

    calChips: { gap: spacing.sm },
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

    filters: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm },
    filterChip: {
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.full,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    filterChipActive: { backgroundColor: c.primary, borderColor: c.primary },
    filterText: { ...typography.caption, color: c.text },
    filterTextActive: { color: c.primaryForeground },

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
    taskRowEditing: { backgroundColor: c.primaryBg },
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
    taskTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    taskTitle: { ...typography.body, color: c.text, flexShrink: 1 },
    taskTitleDone: { textDecorationLine: 'line-through', color: c.textMuted },
    taskDescription: { ...typography.caption, color: c.textMuted, marginTop: 1 },
    taskDue: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    taskDueOverdue: { color: c.error },
    taskDelete: { padding: 4 },
  });
}
