// Display helpers for keys and certificates (#58).
import type { CryptoKeyRecord } from '../../stores/crypto-keys-store';

/** Fingerprint in groups of four, upper case (the plugin's fmtFp). */
export function formatFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.replace(/(.{4})/g, '$1 ').trim();
}

/** Short form for lists: the last 16 hex digits. */
export function shortFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return formatFingerprint(hex.slice(-16));
}

/** "Name <email>" or the first address, for prompts and rows. */
export function keyLabel(record: CryptoKeyRecord): string {
  if (record.kind === 'pgp') return record.userIDs[0] || record.emails[0] || shortFingerprint(record.fingerprint);
  const cn = /(?:^|, )CN=([^,]+)/.exec(record.subject)?.[1];
  const email = record.emails[0];
  if (cn && email && !cn.includes(email)) return `${cn} <${email}>`;
  return email || cn || shortFingerprint(record.fingerprint);
}

/** ISO date to YYYY-MM-DD. */
export function shortDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}
