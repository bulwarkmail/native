// Answering an invitation is not a reply: the organizer may be forged, and
// an RSVP must never file them as trusted (that would load remote content
// for the next forgery too). Nothing on the RSVP path calls a trust function
// today; this keeps it that way.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');

describe('answering an invitation never trusts anyone', () => {
  it.each(['src/lib/invitation-actions.ts', 'src/stores/calendar-store.ts', 'src/components/email/CalendarInvitationBanner.tsx'])(
    '%s files nobody as trusted', (path) => {
      expect(readFileSync(join(ROOT, path), 'utf8')).not.toMatch(/addTrustedSender|trustRecipients|addToTrustedSendersBook/);
    },
  );
});
