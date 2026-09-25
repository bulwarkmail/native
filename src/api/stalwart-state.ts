/**
 * Stalwart's JMAP state strings, read back into the change id they carry.
 * Port of the webmail's lib/jmap/stalwart-state.ts.
 *
 * Stalwart writes a state as `n` (initial), `s` + the change id, or `r` + an
 * intermediate position (a /changes call cut short by maxChanges). The change
 * id is LEB128-encoded, then written in base32 with Stalwart's own alphabet
 * (jmap-proto types/state.rs, utils codec/base32_custom.rs; the same from
 * 0.16.0 through 1.0). Change ids only grow on a healthy server, which is what
 * lets a client notice a state that went backwards.
 */

const STALWART_BASE32 = 'abcdefghijklmnopqrstuvwxyz792013';

// A u64 needs at most ten LEB128 bytes.
const MAX_LEB128_BYTES = 10;

function base32Encode(bytes: number[]): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += STALWART_BASE32[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += STALWART_BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): number[] | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const value = STALWART_BASE32.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return bytes;
}

function leb128Encode(value: bigint): number[] {
  const out: number[] = [];
  let rest = value;
  const low7 = BigInt(0x7f);
  const shift = BigInt(7);
  while (rest > low7) {
    out.push(Number(rest & low7) | 0x80);
    rest >>= shift;
  }
  out.push(Number(rest));
  return out;
}

function leb128Decode(bytes: number[]): bigint | null {
  let value = BigInt(0);
  for (let i = 0; i < bytes.length && i < MAX_LEB128_BYTES; i++) {
    value |= BigInt(bytes[i] & 0x7f) << BigInt(7 * i);
    // Stalwart reads into a u64 and drops what doesn't fit.
    if ((bytes[i] & 0x80) === 0) return BigInt.asUintN(64, value);
  }
  return null;
}

/**
 * The change id of a Stalwart `s` state, or null for any other string: an
 * initial or intermediate state, another server's format, or anything
 * Stalwart would not have written for that id (a non-canonical encoding).
 * A BigInt, because ids are u64.
 */
export function stalwartChangeId(state: string): bigint | null {
  if (state.length < 2 || state[0] !== 's') return null;
  const bytes = base32Decode(state.slice(1));
  const id = bytes ? leb128Decode(bytes) : null;
  if (id === null) return null;
  return `s${base32Encode(leb128Encode(id))}` === state ? id : null;
}

/**
 * Whether a /changes answer went back from `sinceState` to a lower
 * `newState`. Stalwart's change ids only grow; a lower one means its counters
 * went back - a restore, or an upgrade that kept the old change log but
 * restarted the counters lower (1.0 counts per collection where 0.16 counted
 * per account) - and it then answers an old state with an empty delta,
 * skipping every change since. False for any state not in the exact form
 * Stalwart writes, so it never trips on other servers or while states grow.
 */
export function stalwartStateWentBack(sinceState: string, newState: unknown): boolean {
  if (typeof newState !== 'string') return false;
  const since = stalwartChangeId(sinceState);
  const next = stalwartChangeId(newState);
  return since !== null && next !== null && next < since;
}
