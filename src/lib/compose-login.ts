// Writes the composer and the quick reply make on behalf of the login they
// were opened in (see lib/draft-login). Each goes through the JMAP client
// of the active login, so a switch while one is on screen (a notification
// tap, a deep link) would send it to the other server: an attachment
// uploaded into the other login's blob store, a reply flagged `$answered`
// on whatever message has the original's id there. These check the login
// right before the write, after every await that could let a switch in.

import { uploadBlob, uploadBytes, type UploadBlobOptions } from '../api/blob';
import { jmapClient } from '../api/jmap-client';
import { useAccountStore } from '../stores/account-store';
import { useAuthStore } from '../stores/auth-store';
import { t } from '../stores/locale-store';
import { composerLoginMoved, servedLoginOf } from './draft-login';

/** A write refused because another login is active than the one it belongs to. */
export class ComposerLoginMovedError extends Error {
  constructor() {
    super('The account was switched');
    this.name = 'ComposerLoginMovedError';
  }
}

/** Whether a write for `owner` would now reach another login. */
export function loginMovedFrom(owner: string | null | undefined): boolean {
  return composerLoginMoved(owner, {
    activeAccountId: useAccountStore.getState().activeAccountId,
    servedLogin: servedLoginOf(jmapClient),
  });
}

/** Throws ComposerLoginMovedError when a write for `owner` would reach another login. */
export function assertComposerLogin(owner: string | null | undefined): void {
  if (loginMovedFrom(owner)) throw new ComposerLoginMovedError();
}

/** An upload with no session to the server, and none came up when asked for. */
export class ComposerOfflineError extends Error {
  constructor() {
    super(t('mail_p2_desk.action_offline', "You're offline. This needs a connection."));
    this.name = 'ComposerOfflineError';
  }
}

/**
 * Bring the session up for a write of `owner` when the client has none: a
 * start whose session check found no network leaves the client without one
 * until the session retry runs, and an upload then failed with the client's
 * "Not authenticated - call connect() first" while the server was back.
 */
async function ensureSessionFor(owner: string | null | undefined): Promise<void> {
  if (jmapClient.isConnected) return;
  await useAuthStore.getState().retrySession().catch(() => false);
  // The retry gave a switch time to land.
  assertComposerLogin(owner);
  if (!jmapClient.isConnected) throw new ComposerOfflineError();
}

/** Upload a picked file for a message of `owner`, or refuse once another login is active. */
export async function uploadFileForLogin(
  owner: string | null | undefined,
  uri: string,
  type: string,
  options?: UploadBlobOptions,
): Promise<Awaited<ReturnType<typeof uploadBlob>>> {
  assertComposerLogin(owner);
  await ensureSessionFor(owner);
  return uploadBlob(uri, type, options);
}

/** Upload bytes (a re-uploaded forwarded part) for a message of `owner`, or refuse. */
export async function uploadBytesForLogin(
  owner: string | null | undefined,
  bytes: Uint8Array,
  type: string,
  accountId?: string,
): Promise<Awaited<ReturnType<typeof uploadBytes>>> {
  assertComposerLogin(owner);
  await ensureSessionFor(owner);
  return uploadBytes(bytes, type, accountId);
}
