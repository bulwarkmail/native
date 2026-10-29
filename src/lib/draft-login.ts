// The composer writes through the active login: autosave creates a version
// and destroys the previous one by id, Discard destroys the autosaved draft,
// Send flags the original `$answered`. A notification or permalink for
// another account can switch logins while the composer stays open under the
// message it opens. Back in the composer, those writes went to the other
// login, where the same ids name other messages: an autosave or a discard
// destroyed one of them (webmail 54b197080, d72bff95f). So the composer
// remembers the login it was opened in and writes nothing once that changed.
//
// Logins are registry ids (`username@host`, lib/account-utils). The JMAP
// account id the session names ('b', 'c', ...) is another thing: it repeats
// across servers and never equals a registry id.

import { generateAccountId } from './account-utils';

export interface ComposerLogins {
  /** The registry's active account now. */
  activeAccountId: string | null;
  /** The login (registry id) the JMAP client serves now; null while it is not connected. */
  servedLogin: string | null;
}

/** The registry id of the login a client serves, or null while it serves none. */
export function servedLoginOf(client: { isConnected: boolean; username: string | null; serverUrl: string | null }): string | null {
  if (!client.isConnected || !client.username || !client.serverUrl) return null;
  return generateAccountId(client.username, client.serverUrl);
}

/**
 * Whether the composer opened in `owner` would now write to another login.
 * A client that is not connected yet (a cold start offline) still counts as
 * the owner's while the registry says so: its writes cannot go anywhere else.
 */
export function composerLoginMoved(owner: string | null | undefined, now: ComposerLogins): boolean {
  if (!owner) return false;
  if (now.activeAccountId !== owner) return true;
  return now.servedLogin != null && now.servedLogin !== owner;
}
