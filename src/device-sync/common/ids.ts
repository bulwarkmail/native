/**
 * Identifiers device sync mints and parses: map keys for new JSContact /
 * JSCalendar entries, uids for new objects, and the `<jmapAccountId>/<id>`
 * identities kept in SOURCE_ID / _SYNC_ID (docs/device-sync.md, "Identity").
 */

/** A random source in [0, 1); injectable so tests are deterministic. */
export type RandomSource = () => number;

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomChars(random: RandomSource, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += BASE36[Math.floor(random() * 36) % 36];
  return s;
}

/**
 * Keys for new map entries: `b` + 8 base36 characters. Stalwart parses a
 * numeric key as an array index and generates `k<n>` keys itself, so neither
 * shape is ever minted.
 */
export function makeKeyMinter(random: RandomSource = Math.random): (taken?: Iterable<string>) => string {
  let counter = 0;
  return (taken) => {
    const used = new Set(taken ?? []);
    for (let attempt = 0; attempt < 16; attempt++) {
      const key = `b${randomChars(random, 8)}`;
      if (!used.has(key)) return key;
    }
    // A degenerate random source: count instead of looping forever.
    for (;;) {
      const key = `b${(counter++).toString(36).padStart(8, '0')}`;
      if (!used.has(key)) return key;
    }
  };
}

/** An RFC 4122 v4 UUID from the random source. */
export function uuidFrom(random: RandomSource): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** SOURCE_ID / _SYNC_ID of a server object. JMAP ids never contain `/`. */
export function objectRef(jmapAccountId: string, id: string): string {
  return `${jmapAccountId}/${id}`;
}

/** The parts of an object ref, or null for anything else (a pending marker, another app's value). */
export function parseObjectRef(ref: unknown): { accountId: string; id: string } | null {
  if (typeof ref !== 'string') return null;
  const m = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(ref);
  return m ? { accountId: m[1], id: m[2] } : null;
}

/** `_SYNC_ID` of a local event claimed for upload; `~` never occurs in JMAP ids. */
export const PENDING_PREFIX = '~pending/';

export function pendingRef(uid: string): string {
  return `${PENDING_PREFIX}${uid}`;
}

export function pendingUidOf(ref: unknown): string | null {
  return typeof ref === 'string' && ref.startsWith(PENDING_PREFIX) ? ref.slice(PENDING_PREFIX.length) : null;
}

/** `_SYNC_ID` of an exception row: the master's ref plus `#` and the recurrence id. */
export function exceptionRef(masterRef: string, recurrenceId: string): string {
  return `${masterRef}#${recurrenceId}`;
}

/** Collection keys (`<jmapAccountId>/<collectionId>`), as in SYNC1 and the selections. */
export const collectionKey = objectRef;
export const parseCollectionKey = parseObjectRef;
