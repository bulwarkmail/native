/**
 * What the Security page says after a password change. Stalwart revokes the
 * account's tokens with the old password, refresh token included (webmail
 * #1432, checked on 0.16.27), so a session on tokens (a password plus TOTP
 * sign-in, OAuth) ends with the change. That is told as "sign in again with
 * the new password", and the app opens the sign-in to the account. A 401 on
 * the change itself is the same ending seen from the other side: the server
 * dropped the session as it changed the password. Anything else is an error
 * the form shows.
 */
export type PasswordChangeOutcome =
  | { kind: 'changed' }
  | { kind: 'sign-in-again'; changed: boolean }
  | { kind: 'error'; message: string | null };

export function passwordChangeOutcome(error: unknown, tokenSignIn: boolean): PasswordChangeOutcome {
  if (error === null || error === undefined) {
    return tokenSignIn ? { kind: 'sign-in-again', changed: true } : { kind: 'changed' };
  }
  if (error instanceof Error && error.name === 'AuthenticationError') {
    return { kind: 'sign-in-again', changed: false };
  }
  return { kind: 'error', message: error instanceof Error ? error.message : null };
}
