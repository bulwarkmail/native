import { AUTO_TIME_ZONE, isValidTimeZone } from './time-zone';

// The zones offered in the time zone pickers when the runtime cannot list
// its own (see `availableTimeZones`). The device zone and a synced zone
// missing from it are added by `timeZoneOptions`.
export const COMMON_TIME_ZONES: readonly string[] = [
  'UTC',
  'Europe/London', 'Europe/Dublin', 'Europe/Lisbon',
  'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam',
  'Europe/Brussels', 'Europe/Vienna', 'Europe/Zurich', 'Europe/Prague', 'Europe/Warsaw',
  'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Helsinki', 'Europe/Riga',
  'Europe/Kyiv', 'Europe/Athens', 'Europe/Istanbul', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
  'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Bogota',
  'America/Lima', 'America/Santiago', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
  'Asia/Dubai', 'Asia/Tehran', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok',
  'Asia/Jakarta', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Taipei',
  'Asia/Seoul', 'Asia/Tokyo', 'Australia/Perth', 'Australia/Adelaide', 'Australia/Sydney',
  'Pacific/Auckland',
];

/**
 * Every zone the runtime knows, from `Intl.supportedValuesOf('timeZone')`,
 * else the hand-picked list. Today's Hermes has no `supportedValuesOf` (its
 * Intl offers only `supportedLocalesOf` and `getCanonicalLocales`), so the
 * device keeps the hand-picked list until Hermes adds it; Node and the web
 * get the full list.
 */
export function availableTimeZones(
  intl: { supportedValuesOf?: (key: 'timeZone') => string[] } = Intl as never,
): readonly string[] {
  if (typeof intl.supportedValuesOf !== 'function') return COMMON_TIME_ZONES;
  try {
    const zones = intl.supportedValuesOf('timeZone');
    return Array.isArray(zones) && zones.length > 0 ? zones : COMMON_TIME_ZONES;
  } catch {
    return COMMON_TIME_ZONES;
  }
}

/**
 * Select options for the time zone setting: automatic first, then the
 * device zone, the available zones and the current one, sorted by name.
 */
export function timeZoneOptions(
  deviceZone: string,
  current: string | undefined,
  autoLabel: string,
  zones: readonly string[] = availableTimeZones(),
): { value: string; label: string }[] {
  // V8's `supportedValuesOf` lists no `UTC` (only the Etc/ aliases' targets),
  // and UTC has always been offered.
  const offered = new Set<string>(['UTC', deviceZone, ...zones]);
  if (current && current !== AUTO_TIME_ZONE && isValidTimeZone(current)) offered.add(current);
  return [
    { value: AUTO_TIME_ZONE, label: autoLabel },
    ...[...offered].sort().map((z) => ({ value: z, label: z.replace(/_/g, ' ') })),
  ];
}
