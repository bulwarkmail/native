import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Addresses on internationalized domains (webmail #1100): the composer sends
// a domain typed in Unicode in its ASCII form, shows the From identity as
// written, and a sender on one of the user's own IDN domains reads as
// written in the reader. No React Native renderer in the test env, so this
// checks the wiring; outgoingAddress and toUnicodeEmailOnOwnDomains have unit
// tests in recipients.test.ts and idn.test.ts.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('IDN addresses in the composer and reader', () => {
  it('builds the outgoing To, Cc and Bcc through outgoingAddress', () => {
    const src = read('screens/ComposeScreen.tsx');
    expect(src).toMatch(/function toAddress\(r: \{ name\?: string; email: string \}\): EmailAddress \{\s*return outgoingAddress\(r\);/);
    expect(src).toMatch(/to: expandRecipients\(finalTo\)\.map\(toAddress\)/);
  });

  it('shows the From identity with its domain as written', () => {
    expect(read('screens/ComposeScreen.tsx')).toMatch(/const email = toUnicodeEmail\(from\.email\);/);
    expect(read('components/IdentitySheet.tsx')).toMatch(/\{toUnicodeEmail\(identity\.email\)\}/);
  });

  it('formats the sender address in the reader through useOwnDomainAddress', () => {
    const header = read('components/email/MessageHeader.tsx');
    expect(header).toMatch(/const fromEmail = from\?\.email \? formatAddress\(from\.email\) : '';/);
    expect(header).toMatch(/\{from\?\.name \|\| fromEmail \|\| t\('email_viewer\.unknown_sender'/);
    expect(header).not.toMatch(/\{from\.email\}<\/Text>/);
    const card = read('components/email/ThreadMessageCard.tsx');
    expect(card).toMatch(/\{from\?\.name \|\| \(from\?\.email && formatAddress\(from\.email\)\) \|\|/);
  });
});
