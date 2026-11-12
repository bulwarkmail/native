import type { OrgRetention } from './org-organisation';

/**
 * Days the admin says the server keeps mail in a folder of this role
 * (webmail useRetentionDays): Trash and Junk only, 0 when there is nothing
 * to say.
 */
export function retentionDays(retention: OrgRetention | undefined, role: string | null | undefined): number {
  if (!retention) return 0;
  if (role === 'trash') return retention.trashDays;
  if (role === 'junk') return retention.junkDays;
  return 0;
}
