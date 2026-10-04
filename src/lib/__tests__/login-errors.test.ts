import { describe, it, expect } from 'vitest';
import { describeLoginError } from '../login-errors';
import { PairingError, insecurePairingLinkError, type PairingErrorReason } from '../oauth';
import { AccountLimitError } from '../account-utils';
import { TotpLoginError } from '../totp-login';

function named(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('describeLoginError', () => {
  it('explains a refused token exchange from the error code, not the message', () => {
    const copy = describeLoginError(new TotpLoginError('token_exchange_failed', 'Token exchange failed: 400 invalid_client'));
    expect(copy.title).toBe("That didn't work");
    expect(copy.detail).toBe('Your password and code were accepted, but the mail server refused to start a session for this app. Ask your administrator to check its OAuth client settings.');
  });

  it('keeps the bad password or code message for other TOTP login failures', () => {
    const copy = describeLoginError(new TotpLoginError('invalid_credentials', 'Invalid credentials'));
    expect(copy.detail).toMatch(/authenticator app/i);
  });

  it('turns a rejected credential into an actionable message', () => {
    const copy = describeLoginError(named('AuthenticationError', 'Invalid credentials'));
    expect(copy.title).toBe("That didn't work");
    expect(copy.detail).toMatch(/app password/i);
  });

  it('explains the auth store\'s "Session expired" notice', () => {
    expect(describeLoginError('Session expired').title).toBe('Your session has expired. Please sign in again.');
    expect(describeLoginError('Session expired for this account').title).toBe('Your session has expired. Please sign in again.');
  });

  it('says the account limit is reached and what to do about it', () => {
    const want = {
      title: 'Maximum of 10 accounts reached.',
      detail: 'Remove an account in Settings to add another one.',
    };
    expect(describeLoginError(new AccountLimitError())).toEqual(want);
    // As the store keeps it: the message alone.
    expect(describeLoginError('Maximum of 10 accounts reached')).toEqual(want);
  });

  it('explains a scanned, pasted or tapped pairing link for a plain-http webmail', () => {
    const link = `bulwarkmail://pair?server=${encodeURIComponent('http://webmail.example.org/mail')}&code=${'a1'.repeat(32)}`;
    expect(describeLoginError(insecurePairingLinkError(link))).toEqual({
      title: "This sign-in can't be trusted",
      detail: 'webmail.example.org wants to use an unencrypted connection.',
    });
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

  it('explains a pairing failure the store kept only as a message', () => {
    const copy = describeLoginError(new Error('Pairing code is invalid or has expired'));
    expect(copy.title).toBe('That code has expired or was already used');
    expect(copy.detail).toBe('Show a new one in the webmail and scan again.');
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

describe('describeLoginError for sign-in codes', () => {
  const webmail = { serverUrl: 'https://webmail.example.org/mail' };
  const pairing = (reason: PairingErrorReason, host?: string) =>
    describeLoginError(new PairingError(reason, 'raw message', host ? { host } : undefined), webmail);

  it('says what happened to the code', () => {
    expect(pairing('expired')).toEqual({
      title: 'That code has expired',
      detail: 'Sign-in codes are good for two minutes. Show a new one in the webmail and scan again.',
    });
    expect(pairing('used')).toEqual({
      title: 'That code was already used',
      detail: 'Each code works once. Show a new one in the webmail and scan again.',
    });
    expect(pairing('expired_or_used')).toEqual({
      title: 'That code has expired or was already used',
      detail: 'Show a new one in the webmail and scan again.',
    });
    expect(pairing('invalid')).toEqual({
      title: "That code isn't valid",
      detail: 'Show a new code in the webmail (Settings → Security → Link Mobile App) and scan it.',
    });
  });

  it('names the webmail for problems with the redeem request', () => {
    expect(pairing('unsupported', 'webmail.example.org')).toEqual({
      title: "This webmail can't link devices",
      detail: "webmail.example.org doesn't support sign-in codes. It may need an update, or the link points to the wrong address.",
    });
    expect(pairing('network', 'webmail.example.org')).toEqual({
      title: "Can't reach webmail.example.org",
      detail: 'Check your connection and that your phone can reach the webmail, then try again.',
    });
    // Without a host on the error, the screen's address is used.
    expect(pairing('network').title).toBe("Can't reach webmail.example.org");
    expect(pairing('untrusted', 'webmail.example.org')).toEqual({
      title: "This sign-in can't be trusted",
      detail: "webmail.example.org sent sign-in details for a server the app can't verify.",
    });
    expect(pairing('insecure', 'webmail.example.org')).toEqual({
      title: "This sign-in can't be trusted",
      detail: 'webmail.example.org wants to use an unencrypted connection.',
    });
  });

  it('explains rate limiting and server trouble', () => {
    expect(pairing('rate_limited')).toEqual({ title: 'Too many attempts', detail: 'Wait a minute, then try again.' });
    const server = {
      title: "The webmail couldn't complete the sign-in",
      detail: 'Try again with a new code. If it keeps failing, ask your administrator.',
    };
    expect(pairing('server')).toEqual(server);
    expect(pairing('bad_response')).toEqual(server);
  });

  it('names the mail server when the code worked but connecting did not', () => {
    expect(pairing('connect_failed', 'mail.example.com')).toEqual({
      title: "Signed in, but couldn't connect to mail.example.com",
      detail: 'Show a new code on your computer and scan again.',
    });
  });

  it('translates through t with the host filled in', () => {
    const t = (key: string, _fallback?: string, params?: Record<string, string | number>) =>
      `${key}${params?.host ? `(${params.host})` : ''}`;
    expect(describeLoginError(new PairingError('connect_failed', 'x', { host: 'mail.example.com' }), { t })).toEqual({
      title: 'login.mobile.err_pair_connect_title(mail.example.com)',
      detail: 'login.mobile.err_pair_connect_detail',
    });
    expect(describeLoginError(new PairingError('expired'), { t }).title).toBe('login.mobile.err_code_expired_title');
  });
});
