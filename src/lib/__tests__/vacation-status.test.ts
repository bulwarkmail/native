import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { vacationStatus } from '../vacation-status';

const NOW = new Date(2026, 10, 1, 12, 0);
const day = (offset: number) => new Date(2026, 10, 1 + offset, 12, 0);

describe('vacationStatus', () => {
  it('is scheduled, not active, while the start date is ahead', () => {
    expect(vacationStatus(true, day(3), day(10), NOW)).toBe('scheduled');
    expect(vacationStatus(true, day(3), null, NOW)).toBe('scheduled');
  });

  it('is active inside the range or without dates', () => {
    expect(vacationStatus(true, day(-1), day(2), NOW)).toBe('active');
    expect(vacationStatus(true, null, null, NOW)).toBe('active');
    expect(vacationStatus(true, null, day(1), NOW)).toBe('active');
  });

  it('has ended after the end date', () => {
    expect(vacationStatus(true, day(-5), day(-1), NOW)).toBe('ended');
  });

  it('is inactive when switched off, whatever the dates', () => {
    expect(vacationStatus(false, day(3), day(10), NOW)).toBe('inactive');
  });
});

// Out of office in the phone walkthrough: the pill said "Active" for a range
// that starts next week; the sample reply in the empty body looked typed in,
// next to the warning that the body is empty; and after a save TalkBack read
// the disabled Save as "busy".
describe('the out-of-office pane', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../components/settings/VacationSettings.tsx'), 'utf8')
    .split('\r\n').join('\n');

  it('shows the status from the dates', () => {
    expect(source).toContain('vacationStatus(enabled, fromParsed, toParsed)');
    expect(source).toContain("t('settings.vacation.status.scheduled', 'Scheduled')");
  });

  it('sets an empty subject or body placeholder apart from typed text', () => {
    expect(source).toContain('!body && styles.placeholderShown');
    expect(source).toContain('!subject && styles.placeholderShown');
    expect(source).toMatch(/placeholderShown: \{ fontStyle: 'italic' \}/);
  });

  it('names the Save button, so its old "busy" description is replaced', () => {
    const save = source.slice(source.indexOf('<Button\n          onPress={() => void handleSave()}'));
    expect(save.slice(0, save.indexOf('</Button>'))).toContain('accessibilityLabel={saveLabel}');
  });
});
