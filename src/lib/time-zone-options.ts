import { AUTO_TIME_ZONE, isValidTimeZone } from './time-zone';

// The zones offered in the time zone pickers: a hand-picked list. The
// device zone and a synced zone missing from it are added by
// `timeZoneOptions`.
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
 * Select options for the time zone setting: automatic first, then the
 * device zone, the common zones and the current one, sorted by name.
 */
export function timeZoneOptions(
  deviceZone: string,
  current: string | undefined,
  autoLabel: string,
): { value: string; label: string }[] {
  const zones = new Set<string>([deviceZone, ...COMMON_TIME_ZONES]);
  if (current && current !== AUTO_TIME_ZONE && isValidTimeZone(current)) zones.add(current);
  return [
    { value: AUTO_TIME_ZONE, label: autoLabel },
    ...[...zones].sort().map((z) => ({ value: z, label: z.replace(/_/g, ' ') })),
  ];
}
