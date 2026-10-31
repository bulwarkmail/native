/**
 * What the out-of-office status pill says. Switched on with a start date
 * still ahead, the server sends no replies yet: the pill said "Active" all
 * the same. It says "Scheduled" until the start and "Ended" after the end.
 */
export type VacationStatus = 'inactive' | 'scheduled' | 'active' | 'ended';

export function vacationStatus(
  enabled: boolean,
  from: Date | null,
  until: Date | null,
  now: Date = new Date(),
): VacationStatus {
  if (!enabled) return 'inactive';
  if (from && from.getTime() > now.getTime()) return 'scheduled';
  if (until && until.getTime() <= now.getTime()) return 'ended';
  return 'active';
}
