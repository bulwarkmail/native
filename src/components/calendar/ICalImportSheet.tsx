import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Upload, X, Check, CalendarPlus, AlertTriangle, Clock } from 'lucide-react-native';
import { format, parseISO } from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { uploadBlob } from '../../api/blob';
import { parseCalendarBlob } from '../../api/calendar';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { getCalendarColor } from '../../lib/calendar-utils';

// expo-document-picker is loaded lazily on first use; its native module is not
// linked into every build (matches the FilesScreen / ContactImportSheet flow).
type DocumentPickerModule = typeof import('expo-document-picker');
let documentPickerModule: DocumentPickerModule | null = null;
function loadDocumentPicker(): DocumentPickerModule | null {
  if (documentPickerModule) return documentPickerModule;
  try {
    documentPickerModule = require('expo-document-picker') as DocumentPickerModule;
    return documentPickerModule;
  } catch {
    return null;
  }
}

interface Props {
  visible: boolean;
  onClose: () => void;
  calendars: Calendar[];
  /** Imports the selected events into the chosen calendar; returns count. */
  onImport: (events: Partial<CalendarEvent>[], calendarId: string) => Promise<number>;
  onImported?: (count: number) => void;
}

function eventDateLabel(event: Partial<CalendarEvent>): string | null {
  if (!event.start) return null;
  const d = parseISO(event.start);
  if (isNaN(d.getTime())) return null;
  return event.showWithoutTime ? format(d, 'EEE, MMM d, yyyy') : format(d, 'EEE, MMM d · HH:mm');
}

export function ICalImportSheet({ visible, onClose, calendars, onImport, onImported }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();

  const writable = React.useMemo(
    () => calendars.filter((cal) => !cal.myRights || cal.myRights.mayWrite !== false),
    [calendars],
  );

  const [parsed, setParsed] = React.useState<Partial<CalendarEvent>[]>([]);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [calendarId, setCalendarId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [result, setResult] = React.useState<number | null>(null);

  const slideY = React.useRef(new Animated.Value(900)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;

  const resetState = React.useCallback(() => {
    setParsed([]);
    setSelected(new Set());
    setError(null);
    setLoading(false);
    setImporting(false);
    setResult(null);
  }, []);

  React.useEffect(() => {
    if (visible) {
      resetState();
      if (writable[0]) setCalendarId(writable[0].id);
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 900, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, slideY, overlayOpacity, resetState]);

  const pickFile = async () => {
    const picker = loadDocumentPicker();
    if (!picker) {
      Alert.alert(
        'Import unavailable',
        'The file picker is not installed in this build. Rebuild the app (expo run:android) to enable importing.',
      );
      return;
    }
    setError(null);
    let res;
    try {
      res = await picker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the file picker');
      return;
    }
    if (res.canceled || res.assets.length === 0) return;
    const asset = res.assets[0];
    if (asset.size && asset.size > 5 * 1024 * 1024) {
      setError('That file is too large (max 5 MB).');
      return;
    }

    setLoading(true);
    try {
      // Upload the .ics so the server can parse it (CalendarEvent/parse).
      const { blobId } = await uploadBlob(asset.uri, 'text/calendar');
      const events = await parseCalendarBlob(blobId);
      const usable = events.filter((e) => !!e.start || e['@type'] === 'Task');
      if (usable.length === 0) {
        setError('No events were found in that file.');
        return;
      }
      setParsed(usable);
      setSelected(new Set(usable.map((_, i) => i)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read or parse that file.');
    } finally {
      setLoading(false);
    }
  };

  const toggle = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(parsed.map((_, i) => i)));
  const selectNone = () => setSelected(new Set());

  const doImport = async () => {
    if (!calendarId) {
      Alert.alert('No calendar', 'Create a calendar before importing events.');
      return;
    }
    const toImport = parsed.filter((_, i) => selected.has(i));
    if (toImport.length === 0) return;
    setImporting(true);
    try {
      const count = await onImport(toImport, calendarId);
      setResult(count);
      onImported?.(count);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[styles.sheet, { transform: [{ translateY: slideY }] }]}>
        <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
          <View style={styles.header}>
            <Text style={styles.title}>Import calendar</Text>
            <Pressable onPress={onClose} hitSlop={8} style={styles.close}>
              <X size={20} color={c.text} />
            </Pressable>
          </View>

          {result !== null ? (
            <View style={styles.center}>
              <View style={styles.successBadge}>
                <Check size={26} color={c.primaryForeground} />
              </View>
              <Text style={styles.successText}>
                Imported {result} event{result === 1 ? '' : 's'}.
              </Text>
              <Button variant="outline" size="sm" onPress={onClose}>Done</Button>
            </View>
          ) : parsed.length === 0 ? (
            <View style={styles.center}>
              <Pressable style={styles.dropZone} onPress={() => { void pickFile(); }} disabled={loading}>
                {loading ? (
                  <ActivityIndicator color={c.primary} />
                ) : (
                  <Upload size={32} color={c.textMuted} />
                )}
                <Text style={styles.dropTitle}>{loading ? 'Parsing…' : 'Choose an .ics file'}</Text>
                <Text style={styles.dropHint}>iCalendar — single or multiple events</Text>
              </Pressable>
              {!!error && (
                <View style={styles.errorBox}>
                  <AlertTriangle size={16} color={c.error} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}
            </View>
          ) : (
            <>
              {writable.length > 1 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.calChips}>
                  {writable.map((cal) => (
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

              <View style={styles.toolbar}>
                <Text style={styles.toolbarCount}>
                  {parsed.length} found · {selected.size} selected
                </Text>
                <View style={{ flexDirection: 'row', gap: spacing.md }}>
                  <Pressable onPress={selectAll} hitSlop={6}><Text style={styles.link}>All</Text></Pressable>
                  <Pressable onPress={selectNone} hitSlop={6}><Text style={styles.link}>None</Text></Pressable>
                </View>
              </View>

              <ScrollView style={{ flex: 1 }}>
                {parsed.map((event, idx) => {
                  const isSelected = selected.has(idx);
                  const date = eventDateLabel(event);
                  return (
                    <Pressable
                      key={idx}
                      onPress={() => toggle(idx)}
                      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    >
                      <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
                        {isSelected && <Check size={13} color={c.primaryForeground} />}
                      </View>
                      <Clock size={16} color={c.textMuted} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.rowName} numberOfLines={1}>{event.title || 'Untitled event'}</Text>
                        {!!date && <Text style={styles.rowDate} numberOfLines={1}>{date}</Text>}
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {!!error && (
                <View style={styles.errorBox}>
                  <AlertTriangle size={16} color={c.error} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
                <Button variant="outline" onPress={onClose} disabled={importing}>Cancel</Button>
                <Button
                  onPress={() => { void doImport(); }}
                  disabled={importing || selected.size === 0}
                  icon={importing ? <ActivityIndicator size="small" color={c.primaryForeground} /> : <CalendarPlus size={16} color={c.primaryForeground} />}
                >
                  {importing ? 'Importing…' : `Import ${selected.size}`}
                </Button>
              </View>
            </>
          )}
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: '85%',
      backgroundColor: c.popover,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderTopWidth: 1,
      borderColor: c.border,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { ...typography.h3, color: c.text },
    close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, padding: spacing.xl },
    dropZone: {
      width: '100%',
      borderWidth: 2,
      borderColor: c.border,
      borderStyle: 'dashed',
      borderRadius: radius.lg,
      paddingVertical: spacing.xxxl,
      alignItems: 'center',
      gap: spacing.sm,
    },
    dropTitle: { ...typography.bodyMedium, color: c.text },
    dropHint: { ...typography.caption, color: c.textMuted },
    successBadge: {
      width: 56, height: 56, borderRadius: radius.full,
      backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
    },
    successText: { ...typography.bodyMedium, color: c.text },
    calChips: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
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
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    toolbarCount: { ...typography.caption, color: c.textMuted },
    link: { ...typography.captionMedium, color: c.primary },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm + 2,
      minHeight: 48,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    checkbox: {
      width: 20, height: 20, borderRadius: radius.xs,
      borderWidth: 1, borderColor: c.border,
      alignItems: 'center', justifyContent: 'center',
    },
    checkboxOn: { backgroundColor: c.primary, borderColor: c.primary },
    rowName: { ...typography.body, color: c.text },
    rowDate: { ...typography.caption, color: c.textMuted, marginTop: 1 },
    errorBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.lg,
      marginTop: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.sm,
      backgroundColor: c.errorBg,
      borderWidth: 1,
      borderColor: c.errorBorder,
    },
    errorText: { ...typography.caption, color: c.errorForeground, flex: 1 },
    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
  });
}
