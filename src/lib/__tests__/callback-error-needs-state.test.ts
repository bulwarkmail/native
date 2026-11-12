// An error on the sign-in callback link is only believed when the link
// carries the state of the sign-in the app started. Any app (or a web page
// the user taps a link on) can fire bulwarkmobile://auth/callback while the
// browser sign-in is open.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as WebBrowser from 'expo-web-browser';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock('../client-cert', () => ({
  secureFetch: mockFetch,
  fetchWithoutForeignRedirect: mockFetch,
  mayFollowRedirect: () => true,
  followedOnlyAllowedRedirects: () => true,
}));
vi.mock('../totp-login', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../totp-login')>()),
  forgetLoginClient: vi.fn(),
}));

import { PROVIDER_ERROR_MAX, runWebmailHandoff } from '../oauth';
import { loginWithPkce } from '../oauth-native';
import { describeLoginError } from '../login-errors';
import { forgetLoginClient } from '../totp-login';

const LURE = 'Your mailbox is locked. Call 0800 000 000 or sign in at https://evil.example';
// RIGHT-TO-LEFT OVERRIDE, a directional formatting character.
const RLO = String.fromCharCode(0x202e);
const meta = {
  issuer: 'https://mail.example.com',
  authorization_endpoint: 'https://mail.example.com/authorize',
  token_endpoint: 'https://mail.example.com/auth/token',
};

beforeEach(() => {
  vi.resetAllMocks();
  mockFetch.mockRejectedValue(new Error('no request expected'));
});

describe('forged sign-in callback', () => {
  it('browser sign-in: an error without the right state does not put its text on the sign-in screen', async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({
      type: 'success',
      url: `bulwarkmobile://auth/callback?error=access_denied&error_description=${encodeURIComponent(LURE)}`,
    } as never);
    const err = await loginWithPkce('https://mail.example.com', meta as never, { clientId: 'bulwark-mobile' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).not.toContain('evil.example');
    expect(JSON.stringify(describeLoginError(err))).not.toContain('evil.example');
  });

  it('browser sign-in: the same with a guessed state', async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({
      type: 'success',
      url: `org.bulwarkmail.mobile:/auth/callback?state=00000000000000000000000000000000&error=${encodeURIComponent(LURE)}`,
    } as never);
    const err = await loginWithPkce('https://mail.example.com', meta as never, {
      clientId: 'bulwark-mobile', redirectUri: 'org.bulwarkmail.mobile:/auth/callback',
    }).catch((e) => e);
    expect(String(err.message)).not.toContain('evil.example');
  });

  it('browser sign-in: an error that carries the state of this sign-in is still reported', async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async (url: string) => ({
      type: 'success',
      url: `bulwarkmobile://auth/callback?state=${new URL(url).searchParams.get('state')}&error=access_denied&error_description=The+user+said+no`,
    }) as never);
    const err = await loginWithPkce('https://mail.example.com', meta as never, { clientId: 'bulwark-mobile' }).catch((e) => e);
    expect(String(err.message)).toContain('The user said no');
  });

  it.each([
    ['fragment', `bulwarkmobile://auth/callback#error=${encodeURIComponent(LURE)}`],
    ['query', `bulwarkmobile://auth/callback?error=${encodeURIComponent(LURE)}`],
  ])('webmail hand-off: an error in the %s without the right state is not shown', async (_where, url) => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({ type: 'success', url } as never);
    const err = await runWebmailHandoff('https://webmail.example.com').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).not.toContain('evil.example');
    expect(JSON.stringify(describeLoginError(err))).not.toContain('evil.example');
  });
});

describe('callback errors of the sign-in the app started', () => {
  // A provider elsewhere: the default client, no registration request.
  const idpMeta = {
    issuer: 'https://idp.example.org',
    authorization_endpoint: 'https://idp.example.org/authorize',
    token_endpoint: 'https://idp.example.org/token',
  };
  const answer = (build: (state: string) => string) =>
    vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async (url: string) => ({
      type: 'success',
      url: build(new URL(url).searchParams.get('state') ?? new URL(url).searchParams.get('mobile_state') ?? ''),
    }) as never);

  it('says "sign-in was interrupted" for a link without the state', async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({
      type: 'success', url: `bulwarkmobile://auth/callback#error=access_denied&error_description=${encodeURIComponent(LURE)}`,
    } as never);
    const err = await loginWithPkce('https://mail.example.com', meta as never, { clientId: 'bulwark-mobile' }).catch((e) => e);
    expect(describeLoginError(err).title).toBe('Sign-in was interrupted');
  });

  it('shows the error code when there is no description, also from the fragment', async () => {
    answer((state) => `bulwarkmobile://auth/callback#state=${state}&error=temporarily_unavailable`);
    const err = await loginWithPkce('https://mail.example.com', meta as never, { clientId: 'bulwark-mobile' }).catch((e) => e);
    expect(err.message).toBe('temporarily_unavailable');
  });

  it('shows a long or multi-line description as one short line', async () => {
    const long = `Line one\r\nline\ttwo\u0007${RLO}${'x'.repeat(2000)}`;
    answer((state) => `bulwarkmobile://auth/callback?state=${state}&error=server_error&error_description=${encodeURIComponent(long)}`);
    const err = await loginWithPkce('https://mail.example.com', meta as never, { clientId: 'bulwark-mobile' }).catch((e) => e);
    expect(err.message.length).toBeLessThanOrEqual(PROVIDER_ERROR_MAX);
    expect(err.message).toMatch(/^Line one line two x+…$/);
    const detail = describeLoginError(err).detail ?? '';
    expect(detail).not.toMatch(new RegExp(`[\r\n\t\u0007${RLO}]`));
    expect(detail.length).toBeLessThanOrEqual(PROVIDER_ERROR_MAX);
  });

  it('takes the error on the second redirect scheme with the state', async () => {
    answer((state) => `org.bulwarkmail.mobile:/auth/callback?state=${state}&error=access_denied&error_description=The+user+said+no`);
    const err = await loginWithPkce('https://mail.example.com', meta as never, {
      clientId: 'bulwark-mobile', redirectUri: 'org.bulwarkmail.mobile:/auth/callback',
    }).catch((e) => e);
    expect(err.message).toBe('The user said no');
  });

  it('forgets the remembered client only for a refusal that carries the state', async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({
      type: 'success', url: 'bulwarkmobile://auth/callback?error=invalid_client',
    } as never);
    await loginWithPkce('https://mail.example.com', idpMeta as never).catch(() => undefined);
    expect(forgetLoginClient).not.toHaveBeenCalled();

    answer((state) => `bulwarkmobile://auth/callback?state=${state}&error=invalid_client`);
    await loginWithPkce('https://mail.example.com', idpMeta as never).catch(() => undefined);
    expect(forgetLoginClient).toHaveBeenCalledWith('https://mail.example.com');
  });

  it.each([
    ['query', (state: string) => `bulwarkmobile://auth/callback?state=${state}&error=${encodeURIComponent('access_denied\nby policy')}`],
    ['fragment', (state: string) => `bulwarkmobile://auth/callback#state=${state}&error=${encodeURIComponent('access_denied\nby policy')}`],
  ])('webmail hand-off: an error in the %s with the state is shown as one line', async (_where, build) => {
    answer(build);
    const err = await runWebmailHandoff('https://webmail.example.com').catch((e) => e);
    expect(err.message).toBe('access_denied by policy');
  });
});
