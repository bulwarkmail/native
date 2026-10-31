import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { listAddressLabel } from '../list-sender';
import { toUnicodeEmailOnOwnDomains } from '../idn';

// A sender with no display name on one of the user's own IDN domains showed
// as punycode in the list rows (`info@xn--bcher-kva.de`), while the message
// header already read `info@bücher.de` (webmail thread-list-item.tsx, #1100).

const own = ['me@xn--bcher-kva.de'];
const format = (address: string) => toUnicodeEmailOnOwnDomains(address, own);

describe('listAddressLabel', () => {
  it('reads a bare address on an own IDN domain as written, and leaves others alone', () => {
    expect(listAddressLabel({ email: 'info@xn--bcher-kva.de' }, format, 'Unknown')).toBe('info@bücher.de');
    expect(listAddressLabel({ email: 'info@xn--mnchen-3ya.de' }, format, 'Unknown')).toBe('info@xn--mnchen-3ya.de');
  });

  it('prefers the display name and falls back to the unknown label', () => {
    expect(listAddressLabel({ name: 'Bücher', email: 'info@xn--bcher-kva.de' }, format, 'Unknown')).toBe('Bücher');
    expect(listAddressLabel(undefined, format, 'Unknown')).toBe('Unknown');
    expect(listAddressLabel({ name: '', email: '' }, format, 'Unknown')).toBe('Unknown');
  });
});

describe('list rows', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../screens', file), 'utf8');

  it('name senders and recipients through the own-domain formatter', () => {
    const list = read('EmailListScreen.tsx');
    // Read once by the screen and handed to the memoised rows.
    expect(list).toMatch(/const formatAddress = useOwnDomainAddress\(\);/);
    expect(list).toMatch(/formatAddress=\{formatAddress\}/);
    expect(list.match(/listAddressLabel\([^)]*formatAddress/g)).toHaveLength(2);
    expect(list).not.toMatch(/\.name \|\| [\w.?[\]]*\.email/);

    const unified = read('UnifiedInboxScreen.tsx');
    expect(unified).toMatch(/const formatAddress = useOwnDomainAddress\(\);/);
    expect(unified.match(/listAddressLabel\([^)]*formatAddress/g)).toHaveLength(2);
    expect(unified.match(/senderName\(item, [^)]*\), formatAddress\)/g)).toHaveLength(2);
    expect(unified).not.toMatch(/\.name \|\| [\w.?[\]]*\.email/);
  });
});
