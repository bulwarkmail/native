import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The booking, parcel and order cards only show if the reader renders the
// banner. The webmail draws them above the body, after the invitation banner
// (components/email/email-viewer.tsx:2695). The banner itself is tested in
// structured-mail-banner.test.ts; this checks the reader mounts it.

const messageContent = () =>
  fs.readFileSync(path.resolve(__dirname, '..', '..', 'MessageContent.tsx'), 'utf8');

describe('structured mail mount', () => {
  it('renders the cards banner after the invitation banner, for the same account', () => {
    const src = messageContent();
    expect(src).toMatch(/import \{ StructuredMailBanner \} from '\.\/structured-mail\/StructuredMailBanner';/);
    const invitation = src.indexOf('<CalendarInvitationBanner email={email} jmapAccountId={jmapAccountId} />');
    const cards = src.indexOf('<StructuredMailBanner email={email} jmapAccountId={jmapAccountId} />');
    expect(invitation).toBeGreaterThan(-1);
    expect(cards).toBeGreaterThan(invitation);
  });
});
