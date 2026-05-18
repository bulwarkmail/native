import * as WebBrowser from 'expo-web-browser';

// Webmail-mediated login. Instead of doing OAuth directly against the JMAP
// server (which would need a registered client_id and a mobile redirect URI
// allow-listed on the IdP), the app opens the webmail's /mobile-handoff page,
// the user signs in there with their normal credentials, and the webmail
// redirects back to the app's custom scheme with the verified credentials in
// the URL fragment. Fragments aren't sent to the server, so the password
// never appears in HTTP access logs along the way.

export const HANDOFF_REDIRECT_URI = 'bulwarkmobile://auth/callback';

export interface HandoffCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

export class HandoffError extends Error {}
export class HandoffCancelledError extends HandoffError {
  constructor() {
    super('Sign-in cancelled');
  }
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function buildHandoffUrl(webmailUrl: string, state: string): string {
  const base = webmailUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({
    redirect_uri: HANDOFF_REDIRECT_URI,
    state,
  });
  return `${base}/mobile-handoff?${params.toString()}`;
}

function parseFragment(url: string): URLSearchParams {
  const hashIdx = url.indexOf('#');
  if (hashIdx === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(hashIdx + 1));
}

export async function runWebmailHandoff(webmailUrl: string): Promise<HandoffCredentials> {
  const state = randomState();
  const handoffUrl = buildHandoffUrl(webmailUrl, state);

  const result = await WebBrowser.openAuthSessionAsync(handoffUrl, HANDOFF_REDIRECT_URI);

  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw new HandoffCancelledError();
  }
  if (result.type !== 'success' || !result.url) {
    throw new HandoffError(`Sign-in failed: ${result.type}`);
  }

  const params = parseFragment(result.url);
  const err = params.get('error');
  if (err) throw new HandoffError(err);

  // CSRF guard: the state we generated must round-trip through the webmail
  // unchanged. A mismatch means the redirect didn't come from the flow we
  // started, and the rest of the fragment shouldn't be trusted.
  if (params.get('state') !== state) {
    throw new HandoffError('State mismatch');
  }

  const serverUrl = params.get('server_url');
  const username = params.get('username');
  const password = params.get('password');
  if (!serverUrl || !username || !password) {
    throw new HandoffError('Sign-in response missing credentials');
  }

  return { serverUrl, username, password };
}

WebBrowser.maybeCompleteAuthSession();
