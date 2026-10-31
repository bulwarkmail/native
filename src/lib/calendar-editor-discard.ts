import { Alert } from 'react-native';

type Translate = (key: string, fallback?: string) => string;

/**
 * The editor's form as one comparable string. Dates compare by their
 * instant (JSON renders them as ISO strings); the fields are compared in
 * the order given, which the editor keeps fixed.
 */
export function editorFormSnapshot(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

/**
 * The editor's times as the dirty check compares them. An all-day event
 * compares by its first and last day: the editor seeds its last day as
 * 23:59:59.999 (the exclusive end minus 1 ms) and then sets both to
 * midnight, so comparing instants asked "Discard changes?" for an all-day
 * event opened and closed untouched. A timed one compares by the instant.
 */
export function editorTimesSnapshot(times: { allDay: boolean; start: Date; end: Date }): Record<string, unknown> {
  if (!times.allDay) return { allDay: false, start: times.start, end: times.end };
  return { allDay: true, start: dayKey(times.start), end: dayKey(times.end) };
}

function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whether the form holds changes against `baseline`, the form it opened with (null: not seeded yet). */
export function editorFormChanged(baseline: string | null, current: string): boolean {
  return baseline !== null && baseline !== current;
}

/**
 * Run `discard` at once when nothing would be lost, else after the user
 * confirms "Discard"; "Keep editing" runs `keep` (webmail 13f9f27c4: the
 * event and task editors ask before X, Cancel or Escape drop their changes).
 */
export function askBeforeDiscard(
  dirty: boolean,
  t: Translate,
  discard: () => void,
  keep?: () => void,
): void {
  if (!dirty) {
    discard();
    return;
  }
  Alert.alert(
    t('calendar.discard.title', 'Discard changes?'),
    t('calendar.discard.message', "Your changes haven't been saved."),
    [
      { text: t('calendar.discard.keep', 'Keep editing'), style: 'cancel', onPress: keep },
      { text: t('calendar.discard.confirm', 'Discard'), style: 'destructive', onPress: discard },
    ],
    { cancelable: true, onDismiss: keep },
  );
}
