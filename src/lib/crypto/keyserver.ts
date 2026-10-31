// Recipient PGP key lookup on keys.openpgp.org (VKS API), by fingerprint,
// key ID or (owner-verified) address. Port of the webmail plugin's
// repos/plugins/bulwark-gpg/src/keyserver.js. The keyserver isn't trusted to
// say who owns a key: a fingerprint lookup only counts when the returned key
// has that fingerprint, and an address lookup is confirmed by the user.

import { inspectKey, type PgpKeyInfo } from './pgp';

export const DEFAULT_KEYSERVER = 'https://keys.openpgp.org';

export type KeyQuery = { kind: 'email' | 'fingerprint' | 'keyid' | 'invalid'; value: string };

/** Strip a leading 0x and all whitespace, uppercase. "" if it isn't hex. */
export function normalizeHex(input: string): string {
  const hex = String(input || '').replace(/^0x/i, '').replace(/\s+/g, '').toUpperCase();
  return /^[0-9A-F]+$/.test(hex) ? hex : '';
}

export function classifyQuery(raw: string): KeyQuery {
  const s = String(raw || '').trim();
  if (s.includes('@')) return { kind: 'email', value: s.toLowerCase() };
  const hex = normalizeHex(s);
  if (hex.length === 40 || hex.length === 64) return { kind: 'fingerprint', value: hex };
  if (hex.length === 16) return { kind: 'keyid', value: hex };
  return { kind: 'invalid', value: s };
}

export interface KeyLookupResult {
  query: KeyQuery;
  armored: string;
  info: PgpKeyInfo;
  /** The returned key has the fingerprint asked for. */
  verified: boolean;
}

export class KeyserverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyserverError';
  }
}

/** Look a key up; null when the keyserver has none. */
export async function lookupKey(raw: string, opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {}): Promise<KeyLookupResult | null> {
  const query = classifyQuery(raw);
  if (query.kind === 'invalid') throw new KeyserverError('Enter a full fingerprint (40 or 64 hex characters), a 16-character key ID, or an email address.');
  const base = (opts.baseUrl || DEFAULT_KEYSERVER).replace(/\/+$/, '');
  const path = query.kind === 'email'
    ? `/vks/v1/by-email/${encodeURIComponent(query.value)}`
    : query.kind === 'keyid' ? `/vks/v1/by-keyid/${query.value}` : `/vks/v1/by-fingerprint/${query.value}`;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${base}${path}`, { headers: { Accept: 'application/pgp-keys' } });
  } catch {
    throw new KeyserverError('Could not reach the keyserver.');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new KeyserverError(`Keyserver returned HTTP ${res.status}.`);
  const armored = await res.text();
  if (!/BEGIN PGP PUBLIC KEY BLOCK/.test(armored)) throw new KeyserverError('Keyserver did not return an OpenPGP public key.');
  const info = await inspectKey(armored);
  const fp = info.fingerprint.toUpperCase();
  if (query.kind === 'fingerprint' && fp !== query.value) {
    throw new KeyserverError('The keyserver returned a different key than the fingerprint asked for.');
  }
  const verified = query.kind === 'fingerprint' || (query.kind === 'keyid' && fp.endsWith(query.value));
  return { query, armored, info, verified };
}
