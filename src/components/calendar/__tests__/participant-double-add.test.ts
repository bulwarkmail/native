import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { withAttendee, type Attendee } from '../../../lib/calendar-participants';

const input = fs.readFileSync(path.resolve(__dirname, '../ParticipantInput.tsx'), 'utf8');
const editor = fs.readFileSync(path.resolve(__dirname, '../EventModal.tsx'), 'utf8');

describe('adding a participant with Done', () => {
  it('invites a typed address once although submit and blur both add it', () => {
    // Done fires onSubmitEditing, then onBlur, before the editor re-renders:
    // two updaters run on the same queue.
    const typed: Attendee = { name: '', email: 'userc@example.org' };
    let attendees: Attendee[] = [];
    for (const updater of [(prev: Attendee[]) => withAttendee(prev, typed), (prev: Attendee[]) => withAttendee(prev, typed)]) {
      attendees = updater(attendees);
    }
    expect(attendees).toEqual([typed]);
  });

  it('treats an address in other case or with spaces as the same person', () => {
    const list = [{ name: 'C', email: 'userc@example.org' }];
    expect(withAttendee(list, { name: '', email: ' UserC@Example.org ' })).toBe(list);
    expect(withAttendee(list, { name: '', email: 'userb@example.org' })).toHaveLength(2);
  });

  it('adds through the dedupe in the editor and reads the typed text from a ref', () => {
    expect(editor).toMatch(/onAdd=\{\(a\) => setAttendees\(\(prev\) => withAttendee\(prev, a\)\)\}/);
    const submit = input.slice(input.indexOf('const handleSubmit'), input.indexOf('};', input.indexOf('const handleSubmit')));
    expect(submit).toMatch(/draftRef\.current/);
  });

  it('shows the suggestions above the field, where the keyboard does not cover them', () => {
    const jsx = input.slice(input.indexOf('return ('));
    expect(jsx.indexOf('filteredSuggestions.length > 0')).toBeGreaterThan(-1);
    expect(jsx.indexOf('filteredSuggestions.length > 0')).toBeLessThan(jsx.indexOf('<TextInput'));
  });
});
