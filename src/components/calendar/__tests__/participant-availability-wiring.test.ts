import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Checked on the source: the suite has no React Native renderer. The lookups
// themselves are covered in src/api/__tests__/calendar-availability.test.ts.
const modal = fs.readFileSync(path.resolve(__dirname, '../EventModal.tsx'), 'utf8');

describe('free/busy in the event editor', () => {
  it('shows the attendees’ availability under the participants for the event’s window', () => {
    expect(modal).toMatch(/<ParticipantAvailability attendees=\{attendees\} window=\{availabilityWindow\} \/>/);
    expect(modal).toMatch(/editorAvailabilityWindow\(\{ allDay, start, end \}\)/);
    // Right after the participant list, as in the webmail's event form.
    const input = modal.indexOf('<ParticipantInput');
    const availability = modal.indexOf('<ParticipantAvailability');
    const invitations = modal.indexOf("'calendar.participants.send_invitations'");
    expect(input).toBeGreaterThan(-1);
    expect(availability).toBeGreaterThan(input);
    expect(availability).toBeLessThan(invitations);
  });
});
