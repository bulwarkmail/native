import { describe, expect, it } from 'vitest';
import { AuthenticationError } from '../../../api/jmap-client';
import { passwordChangeOutcome } from '../password-change';

// A password change on Stalwart revokes the session's tokens (0.16 with
// TOTP: the sign-in runs on OAuth tokens). The page says "sign in again"
// instead of showing the 401 as a failed change.

describe('passwordChangeOutcome', () => {
  it('asks a token session to sign in again after the change', () => {
    expect(passwordChangeOutcome(null, true)).toEqual({ kind: 'sign-in-again', changed: true });
    expect(passwordChangeOutcome(null, false)).toEqual({ kind: 'changed' });
  });

  it('takes a 401 on the change for the session it ended, not a failure', () => {
    expect(passwordChangeOutcome(new AuthenticationError('Session expired'), true))
      .toEqual({ kind: 'sign-in-again', changed: false });
  });

  it('shows what the server refused', () => {
    expect(passwordChangeOutcome(new Error('Current secret is incorrect.'), true))
      .toEqual({ kind: 'error', message: 'Current secret is incorrect.' });
  });
});
