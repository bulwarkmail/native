// Sign-in failures reach the UI as raw strings from the JMAP client — "Session
// discovery failed: 404 Not Found", "Network request failed". Those describe
// what the code was doing, not what the person should do next. This maps the
// ones we can recognise onto copy that names a likely cause and an action.
//
// Errors are matched by `name` and message text rather than `instanceof` so
// this module stays free of the api/ and expo dependency graph.
import { MAX_ACCOUNTS } from './account-utils';

export interface LoginErrorCopy {
  title: string;
  detail?: string;
}

type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

export interface LoginErrorContext {
  /** Host shown in "can't reach X" copy. */
  serverUrl?: string | null;
  /** Translator; English copy is used when absent (tests, non-UI callers). */
  t?: Translate;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : '';
}

function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

function hostLabel(serverUrl: string | null | undefined, fallback: string): string {
  if (!serverUrl) return fallback;
  const host = serverUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
  return host || fallback;
}

// A QR / link sign-in failure (`PairingError` in lib/oauth), by reason.
function describePairingError(reason: string | undefined, host: string, t: Translate): LoginErrorCopy | null {
  switch (reason) {
    case 'expired':
      return {
        title: t('login.mobile.err_code_expired_title', 'That code has expired'),
        detail: t('login.mobile.err_code_expired_detail', 'Sign-in codes are good for two minutes. Show a new one in the webmail and scan again.'),
      };
    case 'used':
      return {
        title: t('login.mobile.err_code_used_title', 'That code was already used'),
        detail: t('login.mobile.err_code_used_detail', 'Each code works once. Show a new one in the webmail and scan again.'),
      };
    case 'expired_or_used':
      return {
        title: t('login.mobile.err_code_expired_or_used_title', 'That code has expired or was already used'),
        detail: t('login.mobile.err_code_expired_or_used_detail', 'Show a new one in the webmail and scan again.'),
      };
    case 'invalid':
      return {
        title: t('login.mobile.err_code_invalid_title', "That code isn't valid"),
        detail: t('login.mobile.err_code_invalid_detail', 'Show a new code in the webmail (Settings → Security → Link Mobile App) and scan it.'),
      };
    case 'unsupported':
      return {
        title: t('login.mobile.err_pair_unsupported_title', "This webmail can't link devices"),
        detail: t('login.mobile.err_pair_unsupported_detail', "{host} doesn't support sign-in codes. It may need an update, or the link points to the wrong address.", { host }),
      };
    case 'untrusted':
      return {
        title: t('login.mobile.err_pair_untrusted_title', "This sign-in can't be trusted"),
        detail: t('login.mobile.err_pair_untrusted_detail', "{host} sent sign-in details for a server the app can't verify.", { host }),
      };
    case 'insecure':
      return {
        title: t('login.mobile.err_pair_untrusted_title', "This sign-in can't be trusted"),
        detail: t('login.mobile.err_pair_insecure_detail', '{host} wants to use an unencrypted connection.', { host }),
      };
    case 'network':
      return {
        title: t('login.mobile.err_unreachable_title', "Can't reach {host}", { host }),
        detail: t('login.mobile.err_pair_network_detail', 'Check your connection and that your phone can reach the webmail, then try again.'),
      };
    case 'rate_limited':
      return {
        title: t('login.mobile.err_rate_title', 'Too many attempts'),
        detail: t('login.mobile.err_pair_rate_detail', 'Wait a minute, then try again.'),
      };
    case 'server':
    case 'bad_response':
      return {
        title: t('login.mobile.err_pair_server_title', "The webmail couldn't complete the sign-in"),
        detail: t('login.mobile.err_pair_server_detail', 'Try again with a new code. If it keeps failing, ask your administrator.'),
      };
    case 'connect_failed':
      return {
        title: t('login.mobile.err_pair_connect_title', "Signed in, but couldn't connect to {host}", { host }),
        detail: t('login.mobile.err_pair_connect_detail', 'Show a new code on your computer and scan again.'),
      };
    default:
      return null;
  }
}

export function describeLoginError(err: unknown, context: LoginErrorContext = {}): LoginErrorCopy {
  const name = nameOf(err);
  const message = messageOf(err);
  const lower = message.toLowerCase();
  const t: Translate = context.t ?? ((_key, fallback, params) => {
    let out = fallback ?? _key;
    for (const [k, v] of Object.entries(params ?? {})) out = out.replace(`{${k}}`, String(v));
    return out;
  });
  const host = hostLabel(context.serverUrl, t('login.mobile.the_server', 'the server'));

  if (name === 'PairingError') {
    const pairing = err as { reason?: string; host?: string };
    // The error names the host it is about: the webmail for a failed redeem,
    // the mail server once the code was redeemed (`connect_failed`).
    const pairingHost = pairing.host || host;
    const copy = describePairingError(pairing.reason, pairingHost, t);
    if (copy) return copy;
  }

  if (name === 'TotpRequiredError' || message === 'TOTP_REQUIRED' || lower.includes('two-factor code required')) {
    return {
      title: t('login.mobile.err_totp_title', 'Enter your two-factor code'),
      detail: t('login.mobile.err_totp_detail', 'This account is protected with two-factor sign-in. Type the 6-digit code from your authenticator app.'),
    };
  }

  // Keyed on the code: the message ("Token exchange failed: 400") says nothing a user can act on.
  if (name === 'TotpLoginError' && (err as { code?: string }).code === 'token_exchange_failed') {
    return {
      title: t('login.mobile.err_bad_title', "That didn't work"),
      detail: t('login.error.token_exchange_failed', 'Your password and code were accepted, but the mail server refused to start a session for this app. Ask your administrator to check its OAuth client settings.'),
    };
  }

  if (name === 'TotpLoginError' && lower.includes('invalid')) {
    return {
      title: t('login.mobile.err_bad_title', "That didn't work"),
      detail: t('login.mobile.err_totp_bad_detail', 'Check your password and the current code from your authenticator app, then try again.'),
    };
  }

  if (name === 'RateLimitError' || /\b429\b/.test(message) || lower.includes('rate limited')) {
    const retryMs = (err as { retryAfterMs?: number } | null)?.retryAfterMs;
    const seconds = typeof retryMs === 'number' && Number.isFinite(retryMs) ? Math.max(1, Math.round(retryMs / 1000)) : null;
    return {
      title: t('login.mobile.err_rate_title', 'Too many attempts'),
      detail: seconds
        ? t('login.mobile.err_rate_detail_seconds', 'The server asked us to wait. Try again in about {seconds} seconds.', { seconds })
        : t('login.mobile.err_rate_detail', 'The server asked us to wait a moment. Try again shortly.'),
    };
  }

  if (lower.includes('session discovery failed') && /\b402\b/.test(message)) {
    return {
      title: t('login.mobile.err_totp_title', 'Enter your two-factor code'),
      detail: t('login.mobile.err_totp_detail', 'This account is protected with two-factor sign-in. Type the 6-digit code from your authenticator app.'),
    };
  }

  if (name === 'AuthenticationError' || lower.includes('invalid username or password')) {
    return {
      title: t('login.mobile.err_bad_title', "That didn't work"),
      detail: t('login.mobile.err_bad_detail', 'Check your email and password. If your account uses two-factor sign-in, create an app password in the webmail and use that here.'),
    };
  }

  // A saved session the server no longer accepts (the auth store's
  // "Session expired" notice when the app lands back on sign-in).
  if (lower.includes('session expired')) {
    return { title: t('login.session_expired', 'Your session has expired. Please sign in again.') };
  }

  if (lower.includes('certificate') || lower.includes('ssl') || lower.includes('tls')) {
    return {
      title: t('login.mobile.err_cert_title', "Couldn't verify {host}", { host }),
      detail: t('login.mobile.err_cert_detail', "The server's security certificate was rejected. If this is your own server, check the certificate is valid and not expired."),
    };
  }

  // The endpoint answered, but it isn't a JMAP server — almost always a
  // mistyped host or a webmail that lives on a subpath.
  if (lower.includes('session discovery failed') && /\b40[34]\b/.test(message)) {
    return {
      title: t('login.mobile.err_no_server_title', 'No mail server at {host}', { host }),
      detail: t('login.mobile.err_no_server_detail', 'Double-check the address, or scan a sign-in code from the webmail instead.'),
    };
  }

  if (
    name === 'NetworkError' ||
    name === 'TypeError' ||
    name === 'AbortError' ||
    lower.includes('network request failed') ||
    lower.includes('failed to fetch') ||
    lower.includes('timeout') ||
    lower.includes('timed out')
  ) {
    return {
      title: t('login.mobile.err_unreachable_title', "Can't reach {host}", { host }),
      detail: t('login.mobile.err_unreachable_detail', 'Check your connection and the server address, then try again.'),
    };
  }

  if (lower.includes('session discovery failed') && /\b5\d\d\b/.test(message)) {
    return {
      title: t('login.mobile.err_server_title', '{host} is having trouble', { host }),
      detail: t('login.mobile.err_server_detail', 'The server answered with an error. Try again in a few minutes.'),
    };
  }

  if (lower.includes('no bulwark webmail or sign-in service')) {
    return {
      title: t('login.mobile.err_no_webmail_title', 'No sign-in page at {host}', { host }),
      detail: t('login.mobile.err_no_webmail_detail', 'This server has no Bulwark webmail and no OAuth sign-in. Use a password (or an app password) instead.'),
    };
  }

  // The store keeps a failed pairing as a plain message; without the reason,
  // say both.
  if (lower.includes('pairing code')) {
    return describePairingError('expired_or_used', host, t)!;
  }

  if (lower.includes('state mismatch')) {
    return {
      title: t('login.mobile.err_interrupted_title', 'Sign-in was interrupted'),
      detail: t('login.mobile.err_interrupted_detail', "The response didn't match the request we started. Try signing in again."),
    };
  }

  // No room for another account (AccountLimitError, or its message as the
  // store keeps it).
  if (name === 'AccountLimitError' || /maximum of \d+ accounts/i.test(message)) {
    const count = Number(/maximum of (\d+)/i.exec(message)?.[1]) || MAX_ACCOUNTS;
    return {
      title: t('settings.account.accounts.limit', 'Maximum of {count} accounts reached.', { count }),
      detail: t('login.mobile.err_account_limit_detail', 'Remove an account in Settings to add another one.'),
    };
  }

  // Unrecognised: show what we were told rather than inventing a cause.
  return {
    title: t('login.mobile.err_generic_title', 'Sign-in failed'),
    detail: message || t('login.mobile.err_generic_detail', 'Something went wrong. Try again.'),
  };
}
