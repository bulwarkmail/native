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
