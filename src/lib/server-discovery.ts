// Turn an email address into a JMAP server URL so the sign-in flow doesn't
// have to open with a "Server URL" field nobody knows the answer to.
//
// The probe is deliberately cheap and short-lived: a GET of
// `<base>/.well-known/jmap` against a handful of conventional hosts, all in
// parallel, with a hard deadline. Discovery is an optimisation — if it comes
// back empty the caller falls through to asking for the server by hand, so a
// slow or hostile network must never be worse than typing it in.

import { secureFetch } from './client-cert';

export const DISCOVERY_TIMEOUT_MS = 2500;

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/** Loopback, the Android emulator's host alias, RFC 1918 ranges and `.local`. */
export function isLocalHost(url: string): boolean {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url);
  const host = (m ? m[1] : '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '10.0.2.2') return true;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return true;
  const ip = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** True when a normalised server URL uses plain http. */
export function isCleartextUrl(url: string): boolean {
  return /^http:\/\//i.test(url);
}
const EMAIL_RE = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;

/**
 * Accept what people actually type — `mail.example.com`, `example.com/`,
 * `https://mail.example.com/.well-known/jmap`, `…/jmap/session` — and return
 * the base URL the JMAP client expects, or null if it can't be one.
 */
export function normalizeServerUrl(input: string): string | null {
  let value = input.trim();
  if (!value) return null;

  const scheme = SCHEME_RE.exec(value);
  if (scheme) {
    const protocol = scheme[1].toLowerCase();
    if (protocol !== 'http' && protocol !== 'https') return null;
    value = `${protocol}://${value.slice(scheme[0].length)}`;
  } else {
    value = `https://${value}`;
  }

  // Basic credentials travel in every request. Cleartext is only acceptable
  // for a server on the developer's own machine / LAN; on a public host it
  // would fail opaquely on Android anyway (no cleartext traffic allowed) and
  // leak the password on iOS.
  if (/^http:\/\//i.test(value) && !isLocalHost(value)) return null;

  // Someone pasting the endpoint they found in the webmail's settings gets the
  // same result as someone typing the address they use in the browser. Only
  // the session or API suffix goes, so a base path prefix survives (#971).
  value = value
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\/(?:jmap\/session|\.well-known\/jmap|jmap)$/i, '')
    .replace(/\/+$/, '');

  const host = value.slice(value.indexOf('://') + 3).split('/')[0];
  if (!host || /[\s@]/.test(host)) return null;

  const hostname = host.split(':')[0].toLowerCase();
  if (!hostname) return null;
  if (!hostname.includes('.') && hostname !== 'localhost') return null;

  return value;
}

export function emailDomain(email: string): string | null {
  const match = EMAIL_RE.exec(email.trim());
  return match ? match[1].toLowerCase() : null;
}

export function isEmailAddress(value: string): boolean {
  return emailDomain(value) !== null;
}

function hostOf(url: string): string {
  return url.slice(url.indexOf('://') + 3).split('/')[0].split(':')[0].toLowerCase();
}

/**
 * Hosts worth probing for `domain`, most likely first. The order is also the
 * tie-break order when several respond.
 */
export function serverCandidates(domain: string): string[] {
  return [`https://${domain}`, `https://mail.${domain}`, `https://webmail.${domain}`];
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

function looksLikeSession(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  return 'capabilities' in body || 'apiUrl' in body || 'primaryAccounts' in body;
}

/**
 * True when `baseUrl` looks like a JMAP server.
 *
 * A 401 counts as a hit — an unauthenticated probe of Stalwart's session
 * endpoint is *supposed* to be rejected, and that rejection is proof the
 * endpoint is there. A 200, on the other hand, has to actually contain a
 * session document: a captive portal or a catch-all web server will happily
 * answer 200 with HTML for any path we ask for.
 */
export async function probeJmapServer(
  baseUrl: string,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<boolean> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const abortTimer = setTimeout(() => controller?.abort(), timeoutMs);

  const request = (async () => {
    try {
      const response = await secureFetch(`${baseUrl}/.well-known/jmap`, {
        headers: { Accept: 'application/json' },
        signal: controller?.signal,
      });
      if (response.status === 401) return true;
      if (response.status !== 200) return false;
      return looksLikeSession(await response.json());
    } catch {
      return false;
    }
  })();

  try {
    // The abort signal doesn't reach the native client-certificate path, so
    // race the whole thing rather than trusting the request to give up.
    return await withTimeout(request, timeoutMs, false);
  } finally {
    clearTimeout(abortTimer);
  }
}

export interface DiscoveryOptions {
  /** Servers of already-registered accounts, trusted without a probe. */
  knownServerUrls?: string[];
  timeoutMs?: number;
}

/**
 * Best guess at the mail server for `email`, or null if nothing answered in
 * time. Callers treat null as "ask the user".
 */
export async function discoverServerForEmail(
  email: string,
  options: DiscoveryOptions = {},
): Promise<string | null> {
  const domain = emailDomain(email);
  if (!domain) return null;

  // A server we're already signed in to for this domain needs no probe, and
  // covers the common case of adding a second account on the same host.
  const known = (options.knownServerUrls ?? [])
    .map(normalizeServerUrl)
    .filter((url): url is string => url !== null);
  const alreadyKnown = known.find((url) => {
    const host = hostOf(url);
    return host === domain || host.endsWith(`.${domain}`);
  });
  if (alreadyKnown) return alreadyKnown;

  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const candidates = serverCandidates(domain);
  const results = await Promise.all(
    candidates.map(async (candidate) => ((await probeJmapServer(candidate, timeoutMs)) ? candidate : null)),
  );

  // `find` keeps candidate order, so a bare domain wins over `mail.` even when
  // both answer.
  return results.find((url): url is string => url !== null) ?? null;
}
