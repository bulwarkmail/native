// The composer writes through the active login: autosave creates a version
// and destroys the previous one by id, Discard destroys the autosaved draft,
// Send flags the original `$answered`. A notification or permalink for
// another account can switch logins while the composer stays open under the
// message it opens. Back in the composer, those writes went to the other
// login, where the same ids name other messages: an autosave or a discard
// destroyed one of them (webmail 54b197080, d72bff95f). So the composer
// remembers the login it was opened in and writes nothing once that changed.

export interface ComposerLogins {
  /** The registry's active account now. */
  activeAccountId: string | null;
  /** The account the JMAP client is connected to now; null while it is not connected. */
  connectedAccountId: string | null;
}

/**
 * Whether the composer opened in `owner` would now write to another login.
 * A client that is not connected yet (a cold start offline) still counts as
 * the owner's while the registry says so: its writes cannot go anywhere else.
 */
export function composerLoginMoved(owner: string | null | undefined, now: ComposerLogins): boolean {
  if (!owner) return false;
  if (now.activeAccountId !== owner) return true;
  return now.connectedAccountId != null && now.connectedAccountId !== owner;
}
