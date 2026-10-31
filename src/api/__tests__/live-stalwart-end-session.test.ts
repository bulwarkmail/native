/**
 * Live check of ending the provider's session at sign-out (OIDC
 * RP-Initiated Logout) against a real Stalwart. Opt-in like the other live
 * tests:
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-perf@example.org BULWARK_LIVE_PASS=… \
 *   npx vitest run src/api/__tests__/live-stalwart-end-session.test.ts
 *
 * 1.0 announces an end_session_endpoint and hands out an id token with the
 * tokens; 0.16 has neither, and sign-out opens nothing there. The grant the
 * run makes is revoked again.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import { buildEndSessionUrl, discoverOAuthMetadata, revokeRefreshToken } from '../../lib/oauth-native';
import { exchangePasswordForTokens } from '../../lib/totp-login';

const SERVER = (process.env.BULWARK_LIVE_JMAP ?? '').replace(/\/+$/, '');
const USER = process.env.BULWARK_LIVE_USER ?? '';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const live = SERVER && USER && PASS ? describe : describe.skip;

live('ending the provider session at sign-out (live)', () => {
  it('logs out with the id token where the server announces an end_session_endpoint', async () => {
    const metadata = await discoverOAuthMetadata(SERVER);
    expect(metadata).not.toBeNull();
    const tokens = await exchangePasswordForTokens(SERVER, USER, PASS);
    try {
      if (!metadata!.end_session_endpoint) {
        // 0.16: nothing to open.
        expect(buildEndSessionUrl(SERVER, metadata!, tokens)).toBeNull();
        return;
      }
      // 1.0: the token answer carries an id token (a JWT), kept for the hint.
      expect(tokens.idToken?.split('.')).toHaveLength(3);
      const target = buildEndSessionUrl(SERVER, metadata!, tokens);
      expect(target).not.toBeNull();
      const url = new URL(target!.url);
      expect(url.searchParams.get('id_token_hint')).toBe(tokens.idToken);
      const response = await fetch(target!.url, { redirect: 'manual' });
      // Signed out: a page saying so, or back to where the app asked.
      expect([200, 302, 303]).toContain(response.status);
      if (response.status !== 200) {
        expect(response.headers.get('location')).toBe(url.searchParams.get('post_logout_redirect_uri'));
      }
    } finally {
      await revokeRefreshToken(SERVER, tokens);
    }
  });
});
