// The composer's sender identities when the server can't be asked. A
// composer opened offline showed From "Identity unavailable" with Send off,
// and stayed so after the connection came back until it was closed and
// opened again. It now starts from the identities last read for the login
// and reads them again once it can; the Outbox sends the message later.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Identity } from '../api/types';

const KEY_PREFIX = 'compose:identities:v1:';

function keyFor(localAccountId: string): string {
  return `${KEY_PREFIX}${localAccountId}`;
}

/** The identities last read for the login, or [] when none were kept. */
export async function readCachedIdentities(localAccountId: string | null | undefined): Promise<Identity[]> {
  if (!localAccountId) return [];
  try {
    const raw = await AsyncStorage.getItem(keyFor(localAccountId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed)
      ? parsed.filter((i): i is Identity => !!i && typeof i === 'object' && typeof (i as Identity).id === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Keep what the server just said, for the next composer opened offline. */
export async function writeCachedIdentities(localAccountId: string | null | undefined, identities: Identity[]): Promise<void> {
  if (!localAccountId) return;
  try {
    await AsyncStorage.setItem(keyFor(localAccountId), JSON.stringify(identities));
  } catch { /* best effort */ }
}

export interface ComposerIdentities {
  identities: Identity[];
  /** The server's answer; false while they are only the kept copy. */
  fresh: boolean;
  /** Why neither the server nor a kept copy gave any. */
  error: string | null;
}

/**
 * The server's identities, kept for later; the kept copy when the server
 * can't be reached. An error only when there is neither.
 */
export async function loadComposerIdentities(
  localAccountId: string | null | undefined,
  fetchIdentities: () => Promise<Identity[]>,
): Promise<ComposerIdentities> {
  try {
    const identities = await fetchIdentities();
    if (identities.length > 0) await writeCachedIdentities(localAccountId, identities);
    return { identities, fresh: true, error: null };
  } catch (e) {
    const cached = await readCachedIdentities(localAccountId);
    if (cached.length > 0) return { identities: cached, fresh: false, error: null };
    return { identities: [], fresh: false, error: e instanceof Error ? e.message : 'Failed to load identities' };
  }
}
