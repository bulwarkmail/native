import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { secureFetch } from './client-cert';

// OAuth client ID registered (or accepted unregistered, when the server has
// requireClientRegistration=false like Stalwart 0.16) for the mobile app.
export const OAUTH_CLIENT_ID = 'bulwark-mobile';

// offline_access is required for Stalwart to return a refresh_token; without
// it the session dies as soon as the access token expires.
export const OAUTH_SCOPES = ['openid', 'email', 'profile', 'offline_access'];

export interface OAuthDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  tokenEndpoint: string;
  clientId: string;
}

export class OAuthError extends Error {}
export class OAuthCancelledError extends OAuthError {
  constructor() {
    super('OAuth cancelled');
  }
}

export async function discoverOAuth(serverUrl: string): Promise<OAuthDiscovery> {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  const urls = [
    `${baseUrl}/.well-known/oauth-authorization-server`,
    `${baseUrl}/.well-known/openid-configuration`,
  ];
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const res = await secureFetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        errors.push(`${url} → HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (data.authorization_endpoint && data.token_endpoint) {
        return {
          authorization_endpoint: data.authorization_endpoint,
          token_endpoint: data.token_endpoint,
          revocation_endpoint: data.revocation_endpoint,
        };
      }
      errors.push(`${url} missing endpoints`);
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new OAuthError(`OAuth discovery failed: ${errors.join('; ')}`);
}

// Returns the redirect URI the browser will land on after the user signs in.
// For dev (Expo Go) this is the auth.expo.io proxy; for standalone/prebuild
// builds this is the app's custom scheme (bulwarkmobile://auth/callback).
function getRedirectUri(): string {
  return AuthSession.makeRedirectUri({ scheme: 'bulwarkmobile', path: 'auth/callback' });
}

export async function runOAuthFlow(serverUrl: string): Promise<OAuthTokens> {
  const discovery = await discoverOAuth(serverUrl);
  const redirectUri = getRedirectUri();

  const request = new AuthSession.AuthRequest({
    clientId: OAUTH_CLIENT_ID,
    scopes: OAUTH_SCOPES,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
  });

  // promptAsync() opens the system browser tab and resolves when the OAuth
  // server redirects back to the app via the custom scheme.
  const result = await request.promptAsync({
    authorizationEndpoint: discovery.authorization_endpoint,
  });

  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw new OAuthCancelledError();
  }
  if (result.type !== 'success') {
    const msg =
      result.type === 'error' && result.error
        ? result.error.description || result.error.message || result.type
        : result.type;
    throw new OAuthError(`Authorization failed: ${msg}`);
  }
  const code = result.params.code;
  if (!code) throw new OAuthError('Authorization response missing code');

  // Exchange the authorization code for tokens. Stalwart returns a JSON body
  // with access_token, refresh_token, expires_in.
  const tokenResult = await AuthSession.exchangeCodeAsync(
    {
      clientId: OAUTH_CLIENT_ID,
      code,
      redirectUri,
      extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : undefined,
    },
    { tokenEndpoint: discovery.token_endpoint },
  );

  return {
    accessToken: tokenResult.accessToken,
    refreshToken: tokenResult.refreshToken,
    expiresAt:
      tokenResult.expiresIn != null
        ? Date.now() + tokenResult.expiresIn * 1000
        : undefined,
    tokenEndpoint: discovery.token_endpoint,
    clientId: OAUTH_CLIENT_ID,
  };
}

export async function refreshAccessToken(
  tokens: OAuthTokens,
): Promise<OAuthTokens> {
  if (!tokens.refreshToken) {
    throw new OAuthError('No refresh token available');
  }
  const refreshed = await AuthSession.refreshAsync(
    { clientId: tokens.clientId, refreshToken: tokens.refreshToken },
    { tokenEndpoint: tokens.tokenEndpoint },
  );
  return {
    accessToken: refreshed.accessToken,
    // Rotated refresh tokens replace the previous one; some IdPs omit it and
    // expect the client to reuse the original.
    refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
    expiresAt:
      refreshed.expiresIn != null
        ? Date.now() + refreshed.expiresIn * 1000
        : undefined,
    tokenEndpoint: tokens.tokenEndpoint,
    clientId: tokens.clientId,
  };
}

// Required to dismiss the in-app browser tab once the OAuth redirect fires.
// Safe to call once at module load; expo-web-browser exposes it via a method
// that no-ops on platforms where it isn't needed.
export function warmUpAuthBrowser(): void {
  void WebBrowser.warmUpAsync().catch(() => undefined);
}

WebBrowser.maybeCompleteAuthSession();
