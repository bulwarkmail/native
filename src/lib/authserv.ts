import { splitAuthResinfo } from './auth-resinfo';
import { registrableDomain } from './registrable-domain';

// The authserv-id opens the header, so reading this far is plenty; the cap
// keeps a padded header from costing more than this to search for it.
const MAX_HEADER_LENGTH = 16 * 1024;
// A host name or IPv4 address. Anything else (a quoted string, a stray `=`
// from a header with no authserv-id) is no id we could match a server with.
const AUTHSERV_ID_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

/**
 * The host of an `http(s)://` server URL: lowercased, with no port, brackets
 * or trailing dot. Null for anything else. Read by hand rather than through
 * `new URL()`, whose RN polyfill normalises its input. A backslash ends the
 * authority, as it does for the fetch that connects (WHATWG reads it as `/`
 * in an http URL), so `https://mail.example\@evil.example/` is mail.example's.
 */
export function serverHostOf(serverUrl: string | null | undefined): string | null {
  const match = /^https?:\/\//i.exec(serverUrl?.trim() ?? '');
  if (!match || !serverUrl) return null;
  const rest = serverUrl.trim().slice(match[0].length);
  let authority = rest;
  for (const end of ['/', '\\', '?', '#']) {
    const at = authority.indexOf(end);
    if (at >= 0) authority = authority.slice(0, at);
  }
  authority = authority.slice(authority.lastIndexOf('@') + 1);
  let host: string;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return null;
    host = authority.slice(1, close);
  } else {
    const colon = authority.indexOf(':');
    host = colon >= 0 ? authority.slice(0, colon) : authority;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  return host || null;
}

/**
 * The authserv-id of one Authentication-Results header (RFC 8601 §2.2): the
 * token before the first `;` outside comments and quotes, without a version,
 * lowercased, a trailing dot dropped. Null when the header has no `;` in its
 * first 16 KiB (every valid one has one: "none" is written `; none`), or
 * opens with no plain host name.
 */
export function authservIdOf(header: string): string | null {
  const parts = splitAuthResinfo(header.slice(0, MAX_HEADER_LENGTH));
  if (parts.length < 2) return null;
  const id = parts[0].split(/\s/, 1)[0].toLowerCase().replace(/\.$/, '');
  return AUTHSERV_ID_RE.test(id) ? id : null;
}

function isAtOrUnder(name: string, domain: string): boolean {
  return name === domain || name.endsWith(`.${domain}`);
}

/**
 * Whether a header under `authservId` is the receiving server's own: the id
 * is the JMAP server's host or its registrable domain, or a host under
 * either (a mail domain's MX is rarely the JMAP host itself). A host with
 * no registrable domain (an IP address, `localhost`, a single label) counts
 * only by exact match: nobody owns the names under it. Stalwart stamps its
 * `serverHostname`, and the host in its JMAP `apiUrl` follows serverHostname
 * (checked on Stalwart 0.16.25, 2026-10-10).
 */
export function isTrustedAuthservId(authservId: string, serverHost: string): boolean {
  if (!authservId || !serverHost) return false;
  const domain = registrableDomain(serverHost);
  if (!domain) return authservId === serverHost;
  return isAtOrUnder(authservId, serverHost) || isAtOrUnder(authservId, domain);
}

/**
 * The Authentication-Results headers (in message order) when the topmost one
 * is the receiving server's own, by its authserv-id; else none. Only the
 * topmost is judged: a sender can write a header under the server's id
 * anywhere below it, so a match lower down proves nothing. The ones below a
 * trusted top stay, for the parser to treat as foreign (they can only make
 * SPF worse). With no trusted top, or an unknown host, the message has no
 * results the app trusts.
 *
 * The limit is the server's: RFC 8601 §5 has a receiving MTA remove any
 * incoming header that claims its own authserv-id. A server that doesn't
 * lets a forged header with its id pass as topmost on mail it never
 * stamped. Stalwart 0.16.25 strips none (checked 2026-10-10): forged
 * headers under its exact id, a sibling and its parent domain all stay.
 * On mail from outside it stamps its own above them, so the pin holds.
 * On a local user's authenticated submission it stamps nothing, so a
 * header that user wrote under the server's exact id is the topmost, and
 * its forged pass is trusted. Pinning to the exact id does not close
 * that case; only the server can.
 *
 * Trusting the registrable parent and the hosts under it adds to that.
 * On mail the server never stamped, a sender-written header under any of
 * those ids passes, not only one under the exact id. And a server that
 * strips only its own exact id leaves a forged header under a sibling
 * (`mx2.example.com` beside `mx1.example.com`) in place, where it passes
 * too. Pinning to one exact id would close those, at the cost of every
 * server whose MX id differs from its JMAP host.
 */
export function pinAuthenticationResults(
  headers: readonly string[],
  serverHost: string | null | undefined,
): string[] {
  if (!serverHost || headers.length === 0) return [];
  const id = authservIdOf(headers[0]);
  return id && isTrustedAuthservId(id, serverHost) ? [...headers] : [];
}
