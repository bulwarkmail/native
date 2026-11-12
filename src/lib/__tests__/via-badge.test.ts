import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A message of the user's own said "via <identity>" in the reader, which read
// like a delegation warning; the webmail dropped it and keeps only the
// received-at badge and the sub-address tag (email-identity-badge.tsx,
// 279a1dd59).

describe('"via" badge', () => {
  it("names no identity on the user's own mail and keeps the received-at badge", () => {
    const header = fs.readFileSync(path.resolve(__dirname, '../../components/email/MessageHeader.tsx'), 'utf8');
    expect(header).not.toMatch(/'via \{name\}'/);
    expect(header).not.toMatch(/direction: 'from'/);
    expect(header).toMatch(/if \(fromEmail && identities\.some\(\(i\) => i\.email\?\.toLowerCase\(\) === fromEmail\)\) return null;/);
    expect(header).toMatch(/t\('email_viewer\.received_via', 'to \{name\}', \{ name: viaIdentity\.email \}\)/);
  });
});
