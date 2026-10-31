import { describe, it, expect, vi, beforeEach } from 'vitest';

const alert = vi.fn();
vi.mock('react-native', () => ({ Alert: { alert: (...args: unknown[]) => alert(...args) } }));

import { askBeforeDiscard, editorFormChanged, editorFormSnapshot } from '../calendar-editor-discard';
import { emptyTaskEditor, taskEditorChanged, taskEditorFromTask } from '../task-editor';

const t = (_key: string, fallback?: string) => fallback ?? '';

type Button = { text: string; style?: string; onPress?: () => void };
const buttons = (): Button[] => alert.mock.calls.at(-1)![2] as Button[];

beforeEach(() => alert.mockReset());

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
