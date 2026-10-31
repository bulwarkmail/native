import type { LoginErrorCopy } from '../../lib/login-errors';

type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

/**
 * What to show when the webmail refused the one-time code of a browser
 * sign-in (HandoffRedeemError in lib/oauth). Every refusal spends the code,
 * so each message ends with signing in again, which the Continue button on
 * the same step does. Null for any other error.
 */
export function describeHandoffRedeemError(err: unknown, t: Translate): LoginErrorCopy | null {
  if (!(err instanceof Error) || err.name !== 'HandoffRedeemError') return null;
  const reason = (err as { reason?: string }).reason;
  switch (reason) {
    case 'expired_code':
      return {
        title: t('login.mobile.err_handoff_expired_title', 'The sign-in took too long'),
        detail: t('login.mobile.err_handoff_expired_detail', 'The browser handed the sign-in back after it had expired. Sign in again.'),
      };
    case 'invalid_code':
    case 'invalid_verifier':
    case 'invalid_request':
      return {
        title: t('login.mobile.err_handoff_refused_title', "The webmail didn't accept this sign-in"),
        detail: t('login.mobile.err_handoff_refused_detail', 'The sign-in link was already used or did not come from this sign-in. Sign in again.'),
      };
    case 'rate_limited':
      return {
        title: t('login.mobile.err_rate_title', 'Too many attempts'),
        detail: t('login.mobile.err_handoff_rate_detail', 'Wait a few minutes, then sign in again.'),
      };
    case 'network':
      return {
        title: t('login.mobile.err_handoff_network_title', "Couldn't finish signing in"),
        detail: t('login.mobile.err_handoff_network_detail', 'The webmail could not be reached after you signed in. Check your connection and sign in again.'),
      };
    default:
      return {
        title: t('login.mobile.err_handoff_server_title', "The webmail couldn't complete the sign-in"),
        detail: t('login.mobile.err_handoff_server_detail', 'Sign in again. If it keeps failing, ask your administrator.'),
      };
  }
}
