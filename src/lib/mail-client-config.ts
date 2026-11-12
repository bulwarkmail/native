/**
 * Server settings for other mail apps (Thunderbird, Apple Mail, Outlook,
 * phone apps), read from the mail server's Mozilla autoconfig document.
 * Port of the webmail's lib/mail-client-config.ts.
 *
 * Stalwart 0.16 and 1.0 both serve
 * `/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=<address>`
 * without sign-in, so the app reads it from the server it is signed in to.
 * No other host is asked. Hermes has no DOMParser; the document is flat and
 * small, so its elements are read with a tag scanner.
 */

import { secureFetch } from './client-cert';

export type MailSocketSecurity = 'ssl' | 'starttls' | 'none';

export interface MailServerEndpoint {
  hostname: string;
  port: number;
  security: MailSocketSecurity;
}

export interface MailClientConfig {
  username?: string;
  imap?: MailServerEndpoint;
  smtp?: MailServerEndpoint;
  caldav?: string;
  carddav?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
      const name = e.toLowerCase();
      if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
      if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
      return ENTITIES[name] ?? m;
    });
}

/** The inner XML of each `<tag ...>` element, with its attributes. */
function elements(xml: string, tag: string): Array<{ attrs: Record<string, string>; inner: string }> {
  const out: Array<{ attrs: Record<string, string>; inner: string }> = [];
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[1] ?? '').matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs[a[1]] = decodeXml(a[3] ?? a[4] ?? '');
    }
    out.push({ attrs, inner: m[2] });
  }
  return out;
}

function text(inner: string | undefined, tag: string): string | undefined {
  if (inner === undefined) return undefined;
  const value = elements(inner, tag)[0]?.inner;
  const trimmed = value === undefined ? '' : decodeXml(value).trim();
  return trimmed ? trimmed : undefined;
}

function security(raw: string | undefined): MailSocketSecurity {
  const value = (raw ?? '').toUpperCase();
  if (value === 'SSL' || value === 'TLS') return 'ssl';
  if (value === 'STARTTLS') return 'starttls';
  return 'none';
}

function endpoint(inner: string | undefined): MailServerEndpoint | undefined {
  if (inner === undefined) return undefined;
  const hostname = text(inner, 'hostname');
  const port = Number(text(inner, 'port'));
  if (!hostname || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return { hostname, port, security: security(text(inner, 'socketType')) };
}

function davUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return /^https?:\/\/[^\s/?#]+/i.test(raw) ? raw : undefined;
}

/**
 * Fills the Mozilla autoconfig placeholders from the address the document
 * was asked for. Stalwart writes `%EMAILADDRESS%` as the username whatever
 * address it was asked for. A username with a placeholder left over is
 * dropped, so the caller shows its own.
 */
function fillPlaceholders(value: string | undefined, emailAddress: string | undefined): string | undefined {
  if (!value) return undefined;
  const at = emailAddress ? emailAddress.lastIndexOf('@') : -1;
  const filled = emailAddress && at > 0
    ? value.replace(/%EMAILADDRESS%|%EMAILLOCALPART%|%EMAILDOMAIN%/g, (placeholder) =>
      placeholder === '%EMAILADDRESS%' ? emailAddress
        : placeholder === '%EMAILLOCALPART%' ? emailAddress.slice(0, at) : emailAddress.slice(at + 1))
    : value;
  return /%[A-Z]+%/.test(filled) ? undefined : filled;
}

/**
 * The parts of an autoconfig document a person needs to set up another app.
 * Null for anything that isn't a clientConfig with at least one server.
 */
export function parseMailClientConfig(xml: string, emailAddress?: string): MailClientConfig | null {
  const root = elements(xml.replace(/<!--[\s\S]*?-->/g, ''), 'clientConfig')[0];
  if (!root) return null;
  const imap = elements(root.inner, 'incomingServer').find((el) => el.attrs.type === 'imap')?.inner;
  const smtp = elements(root.inner, 'outgoingServer').find((el) => el.attrs.type === 'smtp')?.inner;
  const calendar = elements(root.inner, 'calendar').find((el) => el.attrs.type === 'caldav')?.inner;
  const contacts = elements(root.inner, 'addressBook').find((el) => el.attrs.type === 'carddav')?.inner;

  const config: MailClientConfig = {
    username: fillPlaceholders(text(imap, 'username') ?? text(smtp, 'username'), emailAddress),
    imap: endpoint(imap),
    smtp: endpoint(smtp),
    caldav: davUrl(text(calendar, 'serverURL')),
    carddav: davUrl(text(contacts, 'serverURL')),
  };
  if (!config.imap && !config.smtp && !config.caldav && !config.carddav) return null;
  return config;
}

/** The autoconfig address on the server the app is signed in to. */
export function mailClientConfigUrl(serverUrl: string, emailAddress: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(emailAddress)}`;
}

/** Reads and parses the server's autoconfig; null when it has none or can't be reached. */
export async function fetchMailClientConfig(
  serverUrl: string,
  emailAddress: string,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = secureFetch,
): Promise<MailClientConfig | null> {
  if (!serverUrl || !emailAddress.includes('@')) return null;
  try {
    const response = await fetchImpl(mailClientConfigUrl(serverUrl, emailAddress), { headers: { Accept: 'application/xml, text/xml' } });
    if (!response.ok) return null;
    return parseMailClientConfig(await response.text(), emailAddress);
  } catch {
    return null;
  }
}
