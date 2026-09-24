/**
 * The IANA time zone the calendar works in.
 *
 * Timed events must be saved with a `timeZone` so other clients, CalDAV
 * syncs and invitees resolve the wall-clock correctly; a floating DTSTART
 * shifts whenever the viewer's zone differs from the author's. Mirrors the
 * webmail's lib/timezone.ts: the user's override when set (#755), otherwise
 * the device zone.
 */

import { useSettingsStore } from '../stores/settings-store';

/** Sentinel for "follow the device" — the default. */
export const AUTO_TIME_ZONE = 'auto';

// Reading the device zone builds an Intl.DateTimeFormat, which is slow on
// Hermes, and task sorting resolves a due per comparison. The zone only
// changes when the user travels or changes it, so a short cache is enough.
const DEVICE_ZONE_TTL_MS = 30_000;
let deviceZoneCache: { zone: string; readAt: number } | null = null;

/** The zone the device reports; `UTC` when detection fails. */
export function getDeviceTimeZone(): string {
  const now = Date.now();
  if (deviceZoneCache && now - deviceZoneCache.readAt < DEVICE_ZONE_TTL_MS) {
    return deviceZoneCache.zone;
  }
  let zone: string;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    zone = 'UTC';
  }
  deviceZoneCache = { zone, readAt: now };
  return zone;
}

const validityCache = new Map<string, boolean>();

/** True when `Intl` accepts `tz` as a time zone identifier. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  let valid = validityCache.get(tz);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      valid = true;
    } catch {
      valid = false;
    }
    validityCache.set(tz, valid);
  }
  return valid;
}

/**
 * Resolve a stored `timeZone` setting to a concrete IANA zone. `auto`, empty
 * or unknown values (a zone synced from a client with a newer tz database)
 * fall back to the device zone instead of throwing later inside Intl.
 */
export function resolveTimeZone(
  setting: string | null | undefined,
  deviceTimeZone = getDeviceTimeZone(),
): string {
  if (!setting || setting === AUTO_TIME_ZONE) return deviceTimeZone;
  return isValidTimeZone(setting) ? setting : deviceTimeZone;
}

/** The zone new timed events are saved in and JMAP queries are interpreted in. */
export function getEffectiveTimeZone(): string {
  let setting: string | null | undefined;
  try {
    setting = useSettingsStore.getState().calendarTimeZone;
  } catch {
    setting = undefined;
  }
  return resolveTimeZone(setting);
}
