// TOTP enrolment helper. Mirrors the webmail's use of `otpauth` (Settings →
// Security → Two-Factor) but without pulling in a native crypto dependency:
// we only need to mint a fresh shared secret and the `otpauth://` enrolment
// URL. The 6-digit code the user types is verified server-side by Stalwart
// (x:AccountPassword/set with otpAuth.otpCode), so we never run HMAC-SHA1 on
// device — that keeps this file dependency-free.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// 20 bytes = 160 bits, matching the webmail's `new OTPAuth.Secret({ size: 20 })`
// and the SHA-1 HMAC block expectation of virtually every authenticator app.
const SECRET_BYTES = 20;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const c = (globalThis as {
    crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array; randomUUID?: () => string };
  }).crypto;

  // Best: a real CSPRNG (web / a polyfilled RN).
  if (c?.getRandomValues) {
    try {
      c.getRandomValues(bytes);
      return bytes;
    } catch {
      // fall through
    }
  }

  // Good enough: derive bytes from crypto.randomUUID, which Hermes exposes
  // even when getRandomValues isn't polyfilled (~122 bits of entropy each).
  if (c?.randomUUID) {
    try {
      let hex = '';
      while (hex.length < length * 2) hex += c.randomUUID().replace(/-/g, '');
      for (let i = 0; i < length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return bytes;
    } catch {
      // fall through
    }
  }

  // Last resort: Math.random. Same trade-off the rest of the app accepts in
  // lib/uuid.ts and lib/oauth.ts; the secret is one-off and server-validated.
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

// RFC 4648 base32, no padding — the form authenticator apps expect in the
// `secret` query parameter.
function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export interface TotpEnrolment {
  // Base32 secret, shown to the user for manual entry.
  secret: string;
  // Same secret grouped in fours for easier manual typing.
  secretFormatted: string;
  // otpauth:// URL — feeds the "Add to authenticator app" deep link and the
  // value sent to the server as otpUrl.
  url: string;
}

export function generateTotpEnrolment(accountLabel: string): TotpEnrolment {
  const secret = base32Encode(randomBytes(SECRET_BYTES));
  const issuer = 'Stalwart';
  const label = accountLabel || 'account';
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  // Label is conventionally "Issuer:account"; both label path and issuer param
  // are encoded so authenticators that read either render a sensible name.
  const url = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params.toString()}`;
  const secretFormatted = secret.replace(/(.{4})/g, '$1 ').trim();
  return { secret, secretFormatted, url };
}
