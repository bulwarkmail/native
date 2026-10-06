import { describe, it, expect } from 'vitest';
import { appendEventNote, buildNoteUpdate } from '../event-note';

// Webmail's handleSaveNoteFromDetail (calendar-app.tsx): the timestamp is
// "yyyy-MM-dd HH:mm" of the display clock; an existing description gets
// "\n\n--- <ts> ---\n<note>" after it, an empty one starts with "--- <ts> ---".
const NOW = new Date(2026, 9, 6, 9, 5);

describe('appendEventNote', () => {
  it('gives a timestamp header and the note when the description is empty', () => {
    expect(appendEventNote('', 'call back', NOW)).toBe('--- 2026-10-06 09:05 ---\ncall back');
    expect(appendEventNote(undefined, 'call back', NOW)).toBe('--- 2026-10-06 09:05 ---\ncall back');
    expect(appendEventNote(null, 'call back', NOW)).toBe('--- 2026-10-06 09:05 ---\ncall back');
  });

  it('keeps the existing text and appends after a blank line', () => {
    expect(appendEventNote('Agenda', 'bring slides', NOW)).toBe(
      'Agenda\n\n--- 2026-10-06 09:05 ---\nbring slides',
    );
  });

  it('trims the note and keeps its inner newlines', () => {
    expect(appendEventNote('A', '  one\ntwo \n', NOW)).toBe('A\n\n--- 2026-10-06 09:05 ---\none\ntwo');
  });

  it('returns null for a blank note', () => {
    expect(appendEventNote('A', '   \n', NOW)).toBeNull();
  });
});

describe('buildNoteUpdate', () => {
  it('patches only the description', () => {
    const event = { id: 'e1', title: 'T', description: 'x', participants: { p: { email: 'a@b.c' } } } as never;
    const patch = buildNoteUpdate(event, 'n', NOW);
    expect(patch).toEqual({ description: 'x\n\n--- 2026-10-06 09:05 ---\nn' });
    expect(Object.keys(patch ?? {})).toEqual(['description']);
  });

  it('returns null for a blank note', () => {
    expect(buildNoteUpdate({ id: 'e1' } as never, ' ', NOW)).toBeNull();
  });
});

describe('noteSaveOptions', () => {
  it('never asks for scheduling messages, and keeps the account', async () => {
    const { noteSaveOptions } = await import('../event-note');
    const account = { appAccountId: 'app-1', jmapAccountId: 'grp' };
    expect(noteSaveOptions(account)).toEqual({ sendSchedulingMessages: false, account });
  });
});
