import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { viaIdentityNameShown } from '../email-headers';

// Mail sent as one of the user's identities read "Ann <ann@x>" with a
// "via ann@x" badge: the sender's address a second time (webmail
// email-identity-badge.tsx shows the identity's name, and only when it adds
// something).

describe('"via" badge', () => {
  it("shows the identity's name only when it differs from what the sender line says", () => {
    const from = { name: 'Ann Smith', email: 'ann@example.org' };
    expect(viaIdentityNameShown({ name: 'Support', email: 'ann@example.org' }, from)).toBe(true);
    expect(viaIdentityNameShown({ name: 'Ann Smith', email: 'ann@example.org' }, from)).toBe(false);
    expect(viaIdentityNameShown({ name: 'ann@example.org', email: 'ann@example.org' }, from)).toBe(false);
    expect(viaIdentityNameShown({ name: '', email: 'ann@example.org' }, from)).toBe(false);
  });

  it("names the identity, not its address, in the reader's badge", () => {
    const header = fs.readFileSync(path.resolve(__dirname, '../../components/email/MessageHeader.tsx'), 'utf8');
    expect(header).toMatch(/'via \{name\}', \{ name: viaIdentity\.identity\.name \}/);
    expect(header).toMatch(/viaIdentityNameShown\(sentAs, from\)/);
  });
});
