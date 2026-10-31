import { describe, it, expect, vi, beforeEach } from 'vitest';

const alert = vi.fn();
vi.mock('react-native', () => ({ Alert: { alert: (...args: unknown[]) => alert(...args) } }));

import { askBeforeDiscard, editorFormChanged, editorFormSnapshot, editorTimesSnapshot } from '../calendar-editor-discard';
import { emptyTaskEditor, taskEditorChanged, taskEditorFromTask } from '../task-editor';
import { editorTimesFromEvent } from '../event-editor-times';
import type { CalendarEvent } from '../../api/types';
import fs from 'node:fs';
import path from 'node:path';

const t = (_key: string, fallback?: string) => fallback ?? '';

type Button = { text: string; style?: string; onPress?: () => void };
const buttons = (): Button[] => alert.mock.calls.at(-1)![2] as Button[];

beforeEach(() => alert.mockReset());

describe('the event editor times in the dirty check', () => {
  // What the editor does with an all-day event it opens: seed the times,
  // then its all-day effect sets start and end to midnight.
  const opened = (event: Partial<CalendarEvent>) => {
    const seeded = editorTimesFromEvent(event as CalendarEvent);
    const s = new Date(seeded.start); s.setHours(0, 0, 0, 0);
    const e = new Date(seeded.end); e.setHours(0, 0, 0, 0);
    if (e < s) e.setTime(s.getTime());
    return { seeded, normalized: { allDay: seeded.allDay, start: s, end: e } };
  };
  const snap = (times: { allDay: boolean; start: Date; end: Date }) =>
    editorFormSnapshot({ title: 'Company holiday', times: editorTimesSnapshot(times) });

  it('finds no change in an all-day event opened and left alone', () => {
    // "Company holiday" as Stalwart 0.16 returns it: a day, P1D.
    const { seeded, normalized } = opened({
      '@type': 'Event', showWithoutTime: true, start: '2026-10-03T00:00:00', duration: 'P1D',
    } as Partial<CalendarEvent>);
    expect(seeded.end.getHours()).toBe(23); // the inclusive last day, 23:59:59.999
    expect(editorFormChanged(snap(seeded), snap(normalized))).toBe(false);
    // Two days, and one with a time zone attached.
    const two = opened({ showWithoutTime: true, start: '2026-10-03T00:00:00', duration: 'P2D' });
    expect(editorFormChanged(snap(two.seeded), snap(two.normalized))).toBe(false);
    const zoned = opened({ showWithoutTime: true, start: '2026-10-03T00:00:00', duration: 'P1D', timeZone: 'Europe/Berlin' });
    expect(editorFormChanged(snap(zoned.seeded), snap(zoned.normalized))).toBe(false);
  });

  it('still sees another day, and a moved timed event', () => {
    const { normalized } = opened({ showWithoutTime: true, start: '2026-10-03T00:00:00', duration: 'P1D' });
    const nextDay = { ...normalized, end: new Date(normalized.end.getTime() + 86_400_000) };
    expect(editorFormChanged(snap(normalized), snap(nextDay))).toBe(true);
    const timed = { allDay: false, start: new Date(2026, 9, 3, 9), end: new Date(2026, 9, 3, 10) };
    expect(editorFormChanged(snap(timed), snap({ ...timed, end: new Date(2026, 9, 3, 10, 30) }))).toBe(true);
    expect(editorFormChanged(snap(timed), snap({ ...timed, allDay: true }))).toBe(true);
  });

  it('is what the event editor compares', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../components/calendar/EventModal.tsx'), 'utf8');
    expect(src).toMatch(/times: editorTimesSnapshot\(\{ allDay, start, end \}\)/);
  });
});

describe('askBeforeDiscard', () => {
  it('closes at once when nothing was changed', () => {
    const close = vi.fn();
    askBeforeDiscard(false, t, close);
    expect(close).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
  });

  it('asks before it drops changes, and closes only on Discard', () => {
    const close = vi.fn();
    const keep = vi.fn();
    askBeforeDiscard(true, t, close, keep);
    expect(close).not.toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toBe('Discard changes?');
    const [keepButton, discardButton] = buttons();
    expect(keepButton.text).toBe('Keep editing');
    keepButton.onPress?.();
    expect(keep).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(discardButton.style).toBe('destructive');
    discardButton.onPress?.();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('editor form changes', () => {
  const form = (title: string, start = new Date('2026-11-02T10:00:00Z')) =>
    editorFormSnapshot({ title, start, attendees: [{ email: 'a@example.com' }] });

  it('counts a typed title or a moved start as a change, the same form as none', () => {
    const baseline = form('Lunch');
    expect(editorFormChanged(baseline, form('Lunch'))).toBe(false);
    expect(editorFormChanged(baseline, form('Lunch with Ana'))).toBe(true);
    expect(editorFormChanged(baseline, form('Lunch', new Date('2026-11-02T11:00:00Z')))).toBe(true);
  });

  it('counts nothing before the form was seeded', () => {
    expect(editorFormChanged(null, form('Lunch'))).toBe(false);
  });
});

describe('taskEditorChanged', () => {
  it('tells a typed title, note, due date or priority from the task as opened', () => {
    const opened = taskEditorFromTask({ id: 't1', title: 'Pay rent', calendarIds: { c1: true } } as never, 'c1');
    expect(taskEditorChanged(opened, { ...opened })).toBe(false);
    expect(taskEditorChanged(opened, { ...opened, title: 'Pay rent today' })).toBe(true);
    expect(taskEditorChanged(opened, { ...opened, description: 'IBAN' })).toBe(true);
    expect(taskEditorChanged(opened, { ...opened, due: new Date('2026-11-03T00:00:00Z') })).toBe(true);
    expect(taskEditorChanged(opened, { ...opened, priority: 'high' })).toBe(true);
  });

  it('compares due dates by their instant', () => {
    const a = { ...emptyTaskEditor('c1'), due: new Date('2026-11-03T09:00:00Z') };
    expect(taskEditorChanged(a, { ...a, due: new Date('2026-11-03T09:00:00Z') })).toBe(false);
  });
});
