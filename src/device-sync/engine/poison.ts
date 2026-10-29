/**
 * Poison markers (docs/device-sync.md, "Uploads", SetErrors): an item the
 * server refused (`invalidProperties`, `invalidPatch`, `tooLarge`,
 * `overQuota`, …) is not retried until its back-off ends (1 h, doubling to
 * a day) or it changes. The engine writes the marker (SYNC4 / SYNC_DATA5)
 * and checks it before planning an upload; the fingerprint covers what the
 * item would upload from: its mapped rows, its flags and its shadow.
 */
import { jsonHash } from '../common/json';
import type { PoisonMarker } from '../planner';

export function poisonFingerprint(content: unknown): string {
  return jsonHash(content);
}

/** True while the marker holds: same fingerprint and the back-off not over. */
export function isBackedOff(marker: PoisonMarker | null, fingerprint: string, now: number): boolean {
  return !!marker && marker.fp === fingerprint && marker.until > now;
}

/** The next marker after a refusal: attempts count up while the item stays the same. */
export function nextMarker(
  previous: PoisonMarker | null,
  fingerprint: string,
  error: { type: string; description?: string },
  now: number,
  backoff: { firstMs: number; maxMs: number },
): PoisonMarker {
  const n = previous && previous.fp === fingerprint ? previous.n + 1 : 1;
  const delay = Math.min(backoff.firstMs * 2 ** (n - 1), backoff.maxMs);
  const marker: PoisonMarker = { fp: fingerprint, type: error.type, n, until: now + delay };
  if (error.description) marker.description = error.description.slice(0, 500);
  return marker;
}
