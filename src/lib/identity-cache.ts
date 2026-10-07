// A small per-account copy of the sending identities, so a composer opened
// offline can still fill From and queue the send. Keyed by the app account id
// (the account registry id, unique per login and server); a cache is only
// ever read for the account that wrote it. Forgotten when the account signs
// out (account-data-cleanup).

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { EmailAddress, Identity } from '../api/types';

export const IDENTITY_CACHE_PREFIX = 'webmail:identities:v1:';
export const MAX_CACHED_IDENTITIES = 50;
/** Upper bound on the stored JSON, in UTF-16 code units. */
export const MAX_IDENTITY_CACHE_CHARS = 256 * 1024;

export function identityCacheKey(appAccountId: string): string {
  return `${IDENTITY_CACHE_PREFIX}${appAccountId}`;
}

function cleanAddresses(raw: unknown): EmailAddress[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: EmailAddress[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object' || typeof (a as EmailAddress).email !== 'string') continue;
    const { name, email } = a as EmailAddress;
    out.push(typeof name === 'string' ? { name, email } : { email });
  }
  return out;
}

/** The fields the composer uses, or null when the row is not an identity. */
function cleanIdentity(raw: unknown): Identity | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || typeof r.email !== 'string') return null;
  const out: Identity = {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : '',
    email: r.email,
    mayDelete: r.mayDelete === true,
  };
  const replyTo = cleanAddresses(r.replyTo);
  if (replyTo) out.replyTo = replyTo;
  const bcc = cleanAddresses(r.bcc);
  if (bcc) out.bcc = bcc;
  if (typeof r.textSignature === 'string') out.textSignature = r.textSignature;
  if (typeof r.htmlSignature === 'string') out.htmlSignature = r.htmlSignature;
  return out;
}

/** The account's cached identities; empty when missing, unreadable or corrupt. */
export async function readIdentityCache(appAccountId: string): Promise<Identity[]> {
  try {
    const raw = await AsyncStorage.getItem(identityCacheKey(appAccountId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, MAX_CACHED_IDENTITIES)
      .map(cleanIdentity)
      .filter((i): i is Identity => i !== null);
  } catch {
    return [];
  }
}

/**
 * Store the account's identities, bounded in count and size: identities that
 * would push the stored JSON past the limit are left out. Never throws.
 */
export async function writeIdentityCache(appAccountId: string, identities: Identity[]): Promise<void> {
  const kept: Identity[] = [];
  let size = 2; // the surrounding brackets
  for (const raw of identities.slice(0, MAX_CACHED_IDENTITIES)) {
    const clean = cleanIdentity(raw);
    if (!clean) continue;
    const len = JSON.stringify(clean).length + (kept.length > 0 ? 1 : 0);
    if (size + len > MAX_IDENTITY_CACHE_CHARS) continue;
    kept.push(clean);
    size += len;
  }
  try {
    await AsyncStorage.setItem(identityCacheKey(appAccountId), JSON.stringify(kept));
  } catch (e) {
    console.warn('[identity-cache] write failed', e);
  }
}

export async function removeIdentityCache(appAccountId: string): Promise<void> {
  await AsyncStorage.removeItem(identityCacheKey(appAccountId));
}

export interface ComposerIdentities {
  identities: Identity[];
  /** 'fresh' from the server, 'cache' from this account's stored copy, 'none' otherwise. */
  source: 'fresh' | 'cache' | 'none';
  /** The fetch failure, kept when the cache stands in. */
  error: string | null;
}

/**
 * The composer's identities: the server's list (cached for the owner), else
 * the owner's cached list. Another account's cache is never used, and without
 * an owner no cache is read or written.
 */
export async function loadComposerIdentities(
  appAccountId: string | null | undefined,
  fetchIdentities: () => Promise<Identity[]>,
): Promise<ComposerIdentities> {
  try {
    const identities = await fetchIdentities();
    if (appAccountId) await writeIdentityCache(appAccountId, identities);
    return { identities, source: 'fresh', error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Failed to load identities';
    const cached = appAccountId ? await readIdentityCache(appAccountId) : [];
    return cached.length > 0
      ? { identities: cached, source: 'cache', error }
      : { identities: [], source: 'none', error };
  }
}
