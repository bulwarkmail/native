import type { ReauthTarget } from '../../stores/auth-store';

export type LoginStepName = 'choose' | 'email' | 'server' | 'confirm' | 'password';

/**
 * Where signing in to an account again starts (auth store keepForSignIn): a
 * pasted token or a password account at the form, with the token field or
 * the address filled in; an OAuth account at the server's sign-in page.
 */
export function reauthStart(reauth: ReauthTarget | null): {
  step: LoginStepName;
  email: string;
  serverUrl: string;
  tokenMode: boolean;
} {
  if (!reauth) return { step: 'choose', email: '', serverUrl: '', tokenMode: false };
  return {
    step: reauth.method === 'oauth' ? 'confirm' : 'password',
    email: reauth.method === 'token' ? '' : reauth.username,
    serverUrl: reauth.serverUrl,
    tokenMode: reauth.method === 'token',
  };
}
