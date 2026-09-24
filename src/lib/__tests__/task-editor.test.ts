import { describe, it, expect, vi } from 'vitest';

vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: { getState: () => ({ calendarTimeZone: 'Europe/Berlin' }) },
}));

import {
  buildTaskEditorChanges,
  emptyTaskEditor,
  levelToPriority,
  priorityToLevel,
  submitTaskEditor,
  type TaskEditorState,
} from '../task-editor';
import type { CalendarEvent } from '../../api/types';

function editor(partial: Partial<TaskEditorState>): TaskEditorState {
  return { ...emptyTaskEditor('cal-1'), title: 'Buy milk', ...partial };
}

const existing = {
  id: 't1',
  title: 'Old',
  calendarIds: { 'cal-1': true },
} as unknown as CalendarEvent;

describe('priority mapping', () => {
  it('maps RFC 8984 priorities onto the editor levels and back', () => {
    expect(priorityToLevel(undefined)).toBe('none');
    expect(priorityToLevel(0)).toBe('none');
    expect(priorityToLevel(3)).toBe('high');
    expect(priorityToLevel(5)).toBe('medium');
    expect(priorityToLevel(7)).toBe('low');
    expect(levelToPriority('high')).toBe(1);
    expect(levelToPriority('none')).toBe(0);
  });
});

describe('buildTaskEditorChanges', () => {
  it('labels a timed due with the calendar zone and a date-only due with none', () => {
    const timed = buildTaskEditorChanges(editor({ due: new Date(2026, 8, 24, 17, 30), withTime: true }));
    expect(timed).toMatchObject({
      title: 'Buy milk',
      due: '2026-09-24T17:30:00',
      showWithoutTime: false,
      timeZone: 'Europe/Berlin',
    });
    const dateOnly = buildTaskEditorChanges(editor({ due: new Date(2026, 8, 24, 17, 30) }));
    expect(dateOnly).toMatchObject({ due: '2026-09-24T00:00:00', showWithoutTime: true, timeZone: null });
  });

  it('clears the due of an edited task and sends a changed calendar only', () => {
    expect(buildTaskEditorChanges(editor({ id: 't1' }), existing)).toMatchObject({ due: null });
    expect(buildTaskEditorChanges(editor({ id: 't1' }), existing).calendarIds).toBeUndefined();
    expect(buildTaskEditorChanges(editor({ id: 't1', calendarId: 'cal-2' }), existing).calendarIds)
      .toEqual({ 'cal-2': true });
  });
});

describe('submitTaskEditor', () => {
  it('creates a new task as needs-action in the chosen calendar', async () => {
    const onCreate = vi.fn(async () => undefined);
    const result = await submitTaskEditor(editor({ calendarId: 'cal-2' }), [], { onCreate });
    expect(result).toEqual({ ok: true });
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Buy milk', progress: 'needs-action' }),
      'cal-2',
    );
  });

  it('reports a refused create with the server reason instead of throwing', async () => {
    const onCreate = vi.fn(async () => {
      throw new Error('forbidden: calendar is read-only');
    });
    const result = await submitTaskEditor(editor({}), [], { onCreate });
    expect(result).toEqual({ ok: false, message: 'forbidden: calendar is read-only' });
  });

  it('reports a refused update too', async () => {
    const onUpdate = vi.fn(async () => {
      throw new Error('invalidProperties');
    });
    const result = await submitTaskEditor(editor({ id: 't1' }), [existing], {
      onCreate: vi.fn(),
      onUpdate,
    });
    expect(onUpdate).toHaveBeenCalledWith('t1', expect.objectContaining({ title: 'Buy milk' }));
    expect(result).toEqual({ ok: false, message: 'invalidProperties' });
  });

  it('reports a failure without a message', async () => {
    const result = await submitTaskEditor(editor({}), [], {
      onCreate: () => Promise.reject('nope'),
    });
    expect(result).toEqual({ ok: false, message: undefined });
  });
});
