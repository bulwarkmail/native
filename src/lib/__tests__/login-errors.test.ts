import { describe, it, expect } from 'vitest';
import { describeLoginError } from '../login-errors';

function named(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('describeLoginError', () => {
  it('turns a rejected credential into an actionable message', () => {
    const copy = describeLoginError(named('AuthenticationError', 'Invalid credentials'));
    expect(copy.title).toBe("That didn't work");
    expect(copy.detail).toMatch(/app password/i);
  });

  it('explains the auth store\'s "Session expired" notice', () => {
    expect(describeLoginError('Session expired').title).toBe('Your session has expired. Please sign in again.');
    expect(describeLoginError('Session expired for this account').title).toBe('Your session has expired. Please sign in again.');
  });

  it('names the host it could not reach', () => {
    const copy = describeLoginError(named('NetworkError', 'Network request failed'), {
      serverUrl: 'https://mail.example.com',
    });
    expect(copy.title).toBe("Can't reach mail.example.com");
  });

  it('falls back to a generic host label when the server is unknown', () => {
    const copy = describeLoginError(named('TypeError', 'Network request failed'));
    expect(copy.title).toBe("Can't reach the server");
  });

  it('explains a 404 from session discovery as a wrong address', () => {
    const copy = describeLoginError(new Error('Session discovery failed: 404 Not Found'), {
      serverUrl: 'https://example.com',
    });
    expect(copy.title).toBe('No mail server at example.com');
  });

  it('flags a certificate problem separately from a connection problem', () => {
    const copy = describeLoginError(new Error('SSL certificate has expired'), {
      serverUrl: 'https://mail.example.com',
    });
    expect(copy.title).toBe("Couldn't verify mail.example.com");
  });

  it('explains an expired pairing code', () => {
    const copy = describeLoginError(new Error('Pairing code is invalid or has expired'));
    expect(copy.title).toBe('That code has expired');
    expect(copy.detail).toMatch(/fresh one/i);
  });

  it('passes through an unrecognised message rather than inventing a cause', () => {
    const copy = describeLoginError(new Error('Teapot refused to brew'));
    expect(copy.title).toBe('Sign-in failed');
    expect(copy.detail).toBe('Teapot refused to brew');
  });

  it('handles non-Error throws', () => {
    expect(describeLoginError(undefined).title).toBe('Sign-in failed');
    expect(describeLoginError('boom').detail).toBe('boom');
  });
});
