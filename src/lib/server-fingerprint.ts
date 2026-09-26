import AsyncStorage from '@react-native-async-storage/async-storage';
import { CAPABILITIES } from '../api/types';
import type { JMAPSession } from '../api/types';
import { sha256Hex } from './sha256';

// What the session says about the server behind an account, so the app can
// tell when the server that filled its caches has been replaced. Stalwart
// exposes no version, and the session `state` changes on every restart (an
// AHash with per-process keys), so the fingerprint is built from what is
// stable: the API URL, the primary account id, and the capability names the
// session and the primary account list. 1.0 adds
// `urn:ietf:params:jmap:metadata` (session and account) and
// `urn:ietf:params:jmap:principals:owner` (every account); 0.16.16 added
// emailpush. An admin switching a feature on or off changes it too, which
// only costs a re-download.

const STORAGE_PREFIX = 'server-fingerprint:v1:';
// The JMAP id the recorded server gave the account's own data. Preferences
// kept per JMAP account (the preferred sender identity, iCal subscriptions)
// are found by it once that server is gone.
const PRIMARY_PREFIX = 'server-primary-account:v1:';

function storageKey(accountId: string): string {
  return STORAGE_PREFIX + accountId;
}

/** The session's primary account, picked the way JMAPClient picks it. */
export function primaryAccountId(session: JMAPSession): string {
  return session.primaryAccounts?.[CAPABILITIES.MAIL]
    || session.primaryAccounts?.[CAPABILITIES.CORE]
    || Object.keys(session.accounts ?? {})[0]
    || '';
}

/**
 * A short hash of what identifies the server in a session. Capability values
 * (limits, sort options) and shared accounts are left out: they change with
 * settings and shares, not with the server.
 */
export function sessionFingerprint(session: JMAPSession): string {
  const primary = primaryAccountId(session);
  const parts = [
    session.apiUrl ?? '',
    primary,
    Object.keys(session.capabilities ?? {}).sort(),
    Object.keys(session.accounts?.[primary]?.accountCapabilities ?? {}).sort(),
  ];
  return sha256Hex(new TextEncoder().encode(JSON.stringify(parts))).slice(0, 16);
}

/**
 * The fingerprint recorded for a local account (username@host), or null when
 * none is. A read that fails throws rather than answer null: that would be
 * the first sight of the account, which drops its queued changes (see
 * reconcileServerFingerprint), on a server that may never have changed.
 */
export async function readServerFingerprint(accountId: string): Promise<string | null> {
  return AsyncStorage.getItem(storageKey(accountId));
}

/** The primary JMAP account id recorded with the fingerprint, if any. */
export async function readServerPrimaryAccountId(accountId: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PRIMARY_PREFIX + accountId);
  } catch {
    return null;
  }
}

export async function writeServerFingerprint(
  accountId: string,
  fingerprint: string,
  primaryAccount?: string,
): Promise<void> {
  if (primaryAccount) await AsyncStorage.setItem(PRIMARY_PREFIX + accountId, primaryAccount);
  await AsyncStorage.setItem(storageKey(accountId), fingerprint);
}
