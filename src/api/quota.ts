import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';

// RFC 9425 Quota object (Stalwart reports storage as resourceType "octets"
// with scope "account"); older servers used a pre-RFC "mail" shape.
interface JMAPQuota {
  id: string;
  resourceType?: string;
  used?: number;
  hardLimit?: number;
  warnLimit?: number | null;
  softLimit?: number | null;
  // pre-RFC shape
  limit?: number;
  scope?: string;
  types?: string[];
  name?: string;
}

export interface MailQuota {
  used: number;
  /**
   * The limit the user works against: softLimit when the server sets one
   * below hardLimit, since writes start failing there (RFC 9425 4.1,
   * webmail #1242). Otherwise hardLimit.
   */
  total: number;
  /** hardLimit, only when it is above `total` (inbound mail still lands up to it). */
  hardLimit?: number;
  /** warnLimit, only when it is below `total`. */
  warnAt?: number;
}

const positive = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Picks the mail storage quota out of a Quota/get list (webmail lib/quota.ts toStorageQuota). */
export function toMailQuota(quotas: JMAPQuota[]): MailQuota | null {
  const coversMail = (q: JMAPQuota) =>
    !q.types?.length || q.types.some((t) => t === 'Email' || t === 'Mail');
  // Storage quotas use resourceType "octets" (Stalwart, scope "account");
  // older servers used the pre-RFC "mail" shape.
  const q =
    quotas.find((x) => x.resourceType === 'octets' && coversMail(x))
    || quotas.find((x) => x.resourceType === 'mail' || x.scope === 'mail');
  if (!q) return null;
  const hard = q.hardLimit ?? q.limit ?? 0;
  const soft = positive(q.softLimit) && (!positive(hard) || q.softLimit < hard) ? q.softLimit : undefined;
  const total = soft ?? hard;
  const quota: MailQuota = { used: q.used ?? 0, total };
  if (soft !== undefined && positive(hard)) quota.hardLimit = hard;
  if (positive(q.warnLimit) && (!positive(total) || q.warnLimit < total)) quota.warnAt = q.warnLimit;
  return quota;
}

export function serverSupportsQuota(): boolean {
  return Boolean(jmapClient.currentSession?.capabilities?.[CAPABILITIES.QUOTA]);
}

/**
 * Storage usage for the primary account, or null when the server does not
 * advertise urn:ietf:params:jmap:quota or reports no mail storage quota.
 * Mirrors the webmail's client.getQuota().
 */
export async function fetchMailQuota(): Promise<MailQuota | null> {
  if (!serverSupportsQuota()) return null;
  try {
    const res = await jmapClient.request(
      [['Quota/get', { accountId: jmapClient.accountId }, '0']],
      [CAPABILITIES.CORE, CAPABILITIES.QUOTA],
    );
    const [name, body] = res.methodResponses[0] ?? [];
    if (name !== 'Quota/get') return null;
    return toMailQuota((body?.list ?? []) as JMAPQuota[]);
  } catch {
    return null;
  }
}
