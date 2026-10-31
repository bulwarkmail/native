import { describe, expect, it } from 'vitest';
import { appendEventNote } from '../calendar-event-note';

describe('appendEventNote', () => {
  const now = new Date(2026, 10, 2, 9, 30);

  it('adds the note under a time stamp below what the description holds', () => {
    expect(appendEventNote('Agenda', 'Bring the slides', now)).toBe('Agenda\n\n--- 2026-11-02 09:30 ---\nBring the slides');
  });

  it('starts an empty description with the stamped note', () => {
    expect(appendEventNote('', 'Room 4', now)).toBe('--- 2026-11-02 09:30 ---\nRoom 4');
    expect(appendEventNote(undefined, 'Room 4', now)).toBe('--- 2026-11-02 09:30 ---\nRoom 4');
  });
});
