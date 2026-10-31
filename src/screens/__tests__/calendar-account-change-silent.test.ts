// A calendar write the account switch overtook throws
// CalendarAccountChangedError: the write stopped so that nothing reaches the
// next account. Nothing failed in the account shown now, and the alert
// "Something went wrong" came up over it. The places that show a calendar
// write's error pass it over in silence.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../..');

/** The text of `file` from `marker` to the first `Alert.alert(` after it. */
function beforeAlert(file: string, marker: string): string {
  const src = readFileSync(join(SRC, file), 'utf8');
  const start = src.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const alert = src.indexOf('Alert.alert(', start);
  expect(alert).toBeGreaterThan(start);
  return src.slice(start, alert);
}

const SILENT = /if \(err instanceof CalendarAccountChangedError\)/;

describe('a calendar write the account switch stopped shows no error', () => {
  it('CalendarScreen reportError', () => {
    expect(beforeAlert('screens/CalendarScreen.tsx', 'const reportError = React.useCallback(')).toMatch(SILENT);
  });

  it('CalendarScreen saving or deleting part of a series', () => {
    expect(beforeAlert('screens/CalendarScreen.tsx', "if (!done) throw new Error('Master event not found');")).toMatch(SILENT);
  });

  it('EventModal save', () => {
    expect(beforeAlert('components/calendar/EventModal.tsx', '=> onSave(data, calendarId, {')).toMatch(SILENT);
  });

  it('CalendarScreen gives the scope edits one account for the whole operation', () => {
    const src = readFileSync(join(SRC, 'screens/CalendarScreen.tsx'), 'utf8');
    expect(src.match(/operationScope: calendarOperationScope/g)).toHaveLength(2);
  });
});
