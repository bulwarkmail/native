// What the reader's banner says for each PGP / S/MIME outcome (#58).
import { describe, expect, it } from 'vitest';
import { secureBannerRows } from '../banner-rows';

const t = (_k: string, fallback: string, vars?: Record<string, string | number>) =>
  fallback.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ''));

describe('secureBannerRows', () => {
  it('decrypted and validly signed', () => {
    expect(secureBannerRows({ kind: 'pgp', encrypted: true, decrypted: true, signature: 'valid', signerEmail: 'a@example.org' }, t)).toEqual([
      { key: 'dec', tone: 'ok', text: 'Decrypted (OpenPGP)' },
      { key: 'sig', tone: 'ok', text: 'Valid signature (OpenPGP) from a@example.org' },
    ]);
  });

  it('locked, unsupported, no key, failed', () => {
    const base = { kind: 'smime' as const, encrypted: true, decrypted: false, signature: 'none' as const };
    expect(secureBannerRows({ ...base, lockedKeyIds: ['x'] }, t)[0]).toMatchObject({ key: 'locked', tone: 'warn' });
    expect(secureBannerRows({ ...base, unsupportedAlgorithm: 'RC2-CBC' }, t)[0].text).toBe('Encrypted with RC2-CBC, which the app cannot decrypt.');
    expect(secureBannerRows({ ...base, noKey: true }, t)[0]).toMatchObject({ key: 'nokey', tone: 'error' });
    expect(secureBannerRows({ ...base, error: 'boom' }, t)[0].text).toBe('Could not decrypt: boom');
  });

  it('warns about a signer who is not the sender, a self-signed certificate, an invalid or unknown signature', () => {
    const rows = secureBannerRows({ kind: 'smime', encrypted: false, decrypted: false, signature: 'valid', signerEmail: 's@example.org', signerMismatch: true, selfSigned: true }, t);
    expect(rows.map((r) => [r.key, r.tone])).toEqual([['sig', 'warn'], ['mismatch', 'warn'], ['self', 'muted']]);
    expect(secureBannerRows({ kind: 'pgp', encrypted: false, decrypted: false, signature: 'invalid', error: 'bad' }, t)[0].text).toBe('Invalid signature (OpenPGP): bad');
    expect(secureBannerRows({ kind: 'pgp', encrypted: false, decrypted: false, signature: 'unknown' }, t)[0].tone).toBe('warn');
    expect(secureBannerRows({ kind: 'pgp', encrypted: false, decrypted: false, signature: 'none' }, t)).toEqual([]);
  });
});
