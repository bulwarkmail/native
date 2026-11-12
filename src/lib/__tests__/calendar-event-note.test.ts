import { describe, expect, it } from 'vitest';
import { appendEventNote } from '../calendar-event-note';

describe('appendEventNote', () => {
  const now = new Date(2026, 10, 2, 9, 30);

  it('adds the note under a time stamp below what the description holds', () => {
    expect(appendEventNote({ description: 'Agenda' }, 'Bring the slides', now))
      .toEqual({ description: 'Agenda\n\n--- 2026-11-02 09:30 ---\nBring the slides' });
  });

  it('starts an empty description with the stamped note', () => {
    expect(appendEventNote({ description: '' }, 'Room 4', now)).toEqual({ description: '--- 2026-11-02 09:30 ---\nRoom 4' });
    expect(appendEventNote({}, 'Room 4', now)).toEqual({ description: '--- 2026-11-02 09:30 ---\nRoom 4' });
  });

  it('adds the note to an HTML description as HTML, so it stays HTML', () => {
    expect(appendEventNote({ description: '<p>Agenda</p>', descriptionContentType: 'text/html' }, 'A < B', now))
      .toEqual({ description: '<p>Agenda</p><p>--- 2026-11-02 09:30 ---<br>A &lt; B</p>' });
  });
});
