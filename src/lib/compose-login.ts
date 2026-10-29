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

/** Upload a picked file for a message of `owner`, or refuse once another login is active. */
export async function uploadFileForLogin(
  owner: string | null | undefined,
  uri: string,
  type: string,
  options?: UploadBlobOptions,
): Promise<Awaited<ReturnType<typeof uploadBlob>>> {
  assertComposerLogin(owner);
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
  return uploadBytes(bytes, type, accountId);
}
