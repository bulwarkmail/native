// Header-derived metadata for the reader: SPF/DKIM/DMARC results, spam
// scores, mailing-list headers and read-receipt requests. Port of the
// webmail's `lib/email-headers.ts` plus the header lookups the viewer did
// inline; RN gets raw `headers` (RFC 8621 §4.1.3, an array of {name, value})
// from Email/get instead of the webmail's pre-parsed fields.

import type { Email, Identity } from '../api/types';
import { parseUnsubscribeUrls, type UnsubscribeUrls } from './unsubscribe';
import { resolveReplyFrom } from './reply-identity';

/**
 * The identity a received message was addressed to (exact or `+tag`), for
 * the "via <identity>" badge and as the MDN sender. Falls back to the first
 * identity.
 */
export function findReceivingIdentity(
  identities: Identity[],
  email: Pick<Email, 'to' | 'cc' | 'bcc'>,
): Identity | undefined {
  if (identities.length === 0) return undefined;
  const resolved = resolveReplyFrom(identities, {
    to: email.to ?? undefined, cc: email.cc ?? undefined, bcc: email.bcc ?? undefined,
  });
  if (resolved && !resolved.overrideEmail) {
    return identities.find((i) => i.id === resolved.identityId) ?? identities[0];
  }
  return identities[0];
}

export type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';
export type DkimResult = 'pass' | 'fail' | 'policy' | 'neutral' | 'temperror' | 'permerror';
export type DmarcResult = 'pass' | 'fail' | 'none';
export type DmarcPolicy = 'reject' | 'quarantine' | 'none';

export interface SpfEntry {
  result: SpfResult;
  identity?: 'mailfrom' | 'helo';
  domain?: string;
  /** From a header below the receiving server's own, which the sender may have written. */
  foreign?: true;
}

export interface DkimEntry {
  result: DkimResult;
  domain?: string;
  selector?: string;
}

export interface AuthenticationResults {
  spf?: { result: SpfResult; domain?: string; foreign?: true; all?: SpfEntry[] };
  dkim?: {
    result: DkimResult;
    domain?: string;
    selector?: string;
    /** Every DKIM result when the message carried more than one signature; `result` is the first. */
    all?: DkimEntry[];
  };
  dmarc?: { result: DmarcResult; domain?: string; policy?: DmarcPolicy };
  iprev?: { result: 'pass' | 'fail'; ip?: string };
}

type HeaderList = Email['headers'];

/** All values of a header, case-insensitively, in message order. */
export function headerValues(headers: HeaderList, name: string): string[] {
  if (!headers) return [];
  const needle = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === needle).map((h) => h.value.trim());
}

/** First value of a header, case-insensitively. */
export function headerValue(headers: HeaderList, name: string): string | undefined {
  return headerValues(headers, name)[0];
}

/** Collapse the header array to a name → value(s) record (first-seen casing). */
export function headersToRecord(headers: HeaderList): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const canonical = new Map<string, string>();
  for (const h of headers ?? []) {
    const key = canonical.get(h.name.toLowerCase()) ?? h.name;
    canonical.set(h.name.toLowerCase(), key);
    const value = h.value.trim();
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/**
 * Severity ranking for SPF results. Higher = more severe / more actionable.
 * A hard `fail` is a definitive policy violation and must outrank ambiguous
 * states like `temperror`.
 */
const SPF_SEVERITY: Record<SpfResult, number> = {
  fail: 6,
  softfail: 5,
  permerror: 4,
  temperror: 3,
  neutral: 2,
  none: 1,
  pass: 0,
};

/**
 * Whether the authentication results indicate the visible From identity can't
 * be trusted (i.e. the message is likely spoofed). Used to suppress UI that
 * would otherwise imply the message legitimately came from one of the user's
 * own identities (e.g. the "via <identity>" badge).
 */
export function isAuthenticationSpoofed(auth?: AuthenticationResults): boolean {
  if (!auth) return false;
  if (auth.dmarc?.result === 'fail') return true;
  // Otherwise a hard SPF fail with no valid DKIM signature means the sender
  // isn't authorized for the envelope domain.
  if (auth.spf?.result === 'fail' && !hasDkimPass(auth)) return true;
  return false;
}

function hasDkimPass(auth: AuthenticationResults): boolean {
  return auth.dkim?.result === 'pass' || !!auth.dkim?.all?.some((entry) => entry.result === 'pass');
}

function domainOf(address: string): string | undefined {
  const domain = address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase().replace(/\.$/, '');
  // The address can be sender-written: cap it at a DNS name's length, and
  // match labels that can't overlap, so no input makes the test backtrack.
  if (domain.length > 253) return undefined;
  return /^[^\s<>@.]+(?:\.[^\s<>@.]+)+$/.test(domain) ? domain : undefined;
}

export interface SenderVerification {
  /**
   * `failed`: the message fails the From domain's checks (see
   * isAuthenticationSpoofed). `unverified`: no DMARC pass, and no SPF or
   * DKIM pass for the From domain, so nothing ties the message to it.
   */
  status: 'failed' | 'unverified';
  /** Domain of the visible From address. */
  domain: string;
  /** Envelope (MAIL FROM) host, when it differs from `domain`. */
  sentFrom?: string;
}

/**
 * Whether the receiving server's checks back the visible From domain.
 * Returns null when they do, or when there are no results to judge by.
 *
 * DMARC alone can't answer this: mail-auth (Stalwart) only checks alignment
 * once SPF or DKIM passes, so a message that passes neither reports
 * `dmarc=none` even when the From domain publishes a policy. That is the
 * plainest kind of forgery, so it gets its own verdict here.
 */
export function getSenderVerification(
  auth: AuthenticationResults | undefined,
  fromEmail: string | undefined,
): SenderVerification | null {
  if (!auth || !fromEmail || (!auth.spf && !auth.dkim && !auth.dmarc)) return null;
  const domain = domainOf(fromEmail);
  if (!domain) return null;

  // DMARC only counts the MAIL FROM identity; a HELO pass proves nothing
  // about who wrote the message.
  // The host named comes from the server's own header only: a lower one is
  // the sender's to write.
  const mailFrom = auth.spf?.all?.find((entry) => entry.identity === 'mailfrom' && !entry.foreign);
  const spfPass = auth.spf?.all ? mailFrom?.result === 'pass' : auth.spf?.result === 'pass';
  const envelope = mailFrom?.domain ?? (auth.spf?.foreign ? undefined : auth.spf?.domain);
  const envelopeDomain = envelope ? domainOf(envelope) : undefined;
  const sentFrom = envelopeDomain && envelopeDomain !== domain ? envelopeDomain : undefined;

  if (isAuthenticationSpoofed(auth)) return { status: 'failed', domain, sentFrom };
  if (auth.dmarc?.result === 'pass') return null;
  // A pass vouches for the From domain only when it is for that domain (or a
  // parent or subdomain of it): anyone can pass SPF and DKIM for a domain of
  // their own, and with no DMARC record at the forged one nothing else would
  // flag it. Stricter than webmail, which takes any pass (decision
  // 2026-10-08).
  if (spfPass && envelopeDomain && domainsAlign(envelopeDomain, domain)) return null;
  if (hasAlignedDkimPass(auth, domain)) return null;
  return { status: 'unverified', domain, sentFrom };
}

function domainsAlign(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function hasAlignedDkimPass(auth: AuthenticationResults, fromDomain: string): boolean {
  const entries = auth.dkim?.all ?? (auth.dkim ? [auth.dkim] : []);
  return entries.some((entry) => {
    if (entry.result !== 'pass' || !entry.domain) return false;
    const signer = domainOf(entry.domain);
    return !!signer && domainsAlign(signer, fromDomain);
  });
}

interface ResInfo {
  method: string;
  result: string;
  props: Record<string, string>;
}

/**
 * Split one Authentication-Results header into its `;`-separated parts
 * (RFC 8601), dropping comments. A `;` inside a quoted string or a comment
 * does not split: both can carry sender-chosen text such as the envelope
 * address.
 */
function splitResinfo(header: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (c === '\\' && (quoted || depth > 0)) {
      if (depth === 0) current += c + (header[i + 1] ?? '');
      i++;
      continue;
    }
    if (quoted) {
      current += c;
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '(') {
      depth++;
      continue;
    }
    if (depth > 0) {
      if (c === ')' && --depth === 0) current += ' ';
      continue;
    }
    if (c === '"') quoted = true;
    if (c === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const METHOD_RE = /^([a-z0-9][a-z0-9_-]*)(?:\/\d+)?\s*=\s*([a-z]+)(?=\s|$)/i;
const PROP_RE = /\s*([^\s=]+)\s*=\s*("(?:[^"\\]|\\.)*"|\S*)/y;

/**
 * Read one resinfo: the method must open the part, so a `dmarc=pass` that
 * appears inside a property value (say an envelope local part in
 * `smtp.mailfrom=`) is never taken for a result.
 */
function parseResinfo(part: string): ResInfo | null {
  const match = METHOD_RE.exec(part);
  if (!match) return null;
  const props: Record<string, string> = {};
  const rest = part.slice(match[0].length);
  PROP_RE.lastIndex = 0;
  let prop: RegExpExecArray | null;
  while ((prop = PROP_RE.exec(rest)) !== null && prop[0].length > 0) {
    const key = prop[1].toLowerCase();
    let value = prop[2];
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!(key in props)) props[key] = value;
  }
  return { method: match[1].toLowerCase(), result: match[2].toLowerCase(), props };
}

function parseResinfos(header: string): ResInfo[] {
  return splitResinfo(header)
    .map(parseResinfo)
    .filter((info): info is ResInfo => info !== null);
}

const DMARC_SEVERITY: Record<string, number> = {
  fail: 3,
  permerror: 2,
  temperror: 2,
  none: 1,
  pass: 0,
};

/**
 * Parse Authentication-Results headers into SPF, DKIM, DMARC results.
 *
 * Pass the headers in message order. The topmost one is the receiving
 * server's own; anything below it may have been written by the sender, so
 * DKIM, DMARC and iprev come from the topmost header only, and the others
 * can only escalate SPF to a failure, never supply a pass.
 */
export function parseAuthenticationResults(headers: string | readonly string[]): AuthenticationResults {
  const results: AuthenticationResults = {};
  const list = typeof headers === 'string' ? [headers] : headers;
  const perHeader = list.map(parseResinfos);
  const own = perHeader[0] ?? [];
  const foreign = perHeader.slice(1).flat();

  // Parse SPF. A single Authentication-Results header can carry more than one
  // SPF result when the server evaluates multiple identities (HELO and MAIL
  // FROM). Collect them all so a hard fail on any identity isn't softened to
  // an ambiguous state recorded for another one.
  const severity = (r: string) => SPF_SEVERITY[r as SpfResult] ?? -1;
  const isFailure = (r: string) => severity(r) >= SPF_SEVERITY.temperror;
  const toSpfEntry = (info: ResInfo): SpfEntry => {
    const identity = info.props['smtp.mailfrom'] !== undefined
      ? 'mailfrom'
      : info.props['smtp.helo'] !== undefined ? 'helo' : undefined;
    return {
      result: info.result as SpfResult,
      identity: identity as SpfEntry['identity'],
      domain: identity ? info.props[`smtp.${identity}`] || undefined : undefined,
    };
  };
  const spfResults: SpfEntry[] = [
    ...own.filter((info) => info.method === 'spf').map(toSpfEntry),
    ...foreign
      .filter((info) => info.method === 'spf')
      .map((info): SpfEntry => ({ ...toSpfEntry(info), foreign: true }))
      .filter((e) => isFailure(e.result)),
  ];
  if (spfResults.length > 0) {
    // MAIL FROM is the primary SPF identity. Another identity (HELO) may only
    // escalate the headline to a genuine failure state — a HELO `none` or
    // `neutral` must not downgrade a MAIL FROM `pass`, since most senders
    // publish no SPF record for their EHLO hostname.
    let primary =
      spfResults.find((e) => e.identity === 'mailfrom') ?? spfResults[0];
    for (const cur of spfResults) {
      if (isFailure(cur.result) && severity(cur.result) > severity(primary.result)) {
        primary = cur;
      }
    }
    results.spf = {
      result: primary.result,
      domain: primary.domain,
      ...(primary.foreign ? { foreign: true as const } : {}),
      ...(spfResults.length > 1 ? { all: spfResults } : {}),
    };
  }

  // A message can carry several signatures (the author's domain and the
  // sending service's). The first one stays the headline; keep them all so
  // a pass further down still counts.
  const dkimResults: DkimEntry[] = own
    .filter((info) => info.method === 'dkim')
    .map((info) => ({
      result: info.result as DkimResult,
      domain: info.props['header.d'],
      selector: info.props['header.s'],
    }));
  if (dkimResults.length > 0) {
    results.dkim = {
      ...dkimResults[0],
      ...(dkimResults.length > 1 ? { all: dkimResults } : {}),
    };
  }

  // One DMARC verdict per message; should a header carry several, the most
  // severe stands.
  const dmarc = own
    .filter((info) => info.method === 'dmarc')
    .reduce<ResInfo | undefined>(
      (worst, info) => (!worst || (DMARC_SEVERITY[info.result] ?? -1) > (DMARC_SEVERITY[worst.result] ?? -1) ? info : worst),
      undefined,
    );
  if (dmarc) {
    results.dmarc = {
      result: dmarc.result as DmarcResult,
      domain: dmarc.props['header.from'],
      policy: dmarc.props['policy.dmarc'] as DmarcPolicy | undefined,
    };
  }

  const iprev = own.find((info) => info.method === 'iprev');
  if (iprev) {
    results.iprev = {
      result: iprev.result as 'pass' | 'fail',
      ip: iprev.props['policy.iprev'],
    };
  }

  return results;
}

/** Parse a spam score from X-Spam-Result / X-Spam-Status / X-Spam-Score. */
export function parseSpamScore(header: string): { score: number; status: string } | null {
  // X-Spam-Status: "No, score=-0.25" / Stalwart X-Spam-Result: "ham, score=-0.25"
  const statusMatch = header.match(/^(Yes|No|spam|ham),?\s+score=([-\d.]+)/i);
  if (statusMatch) {
    return {
      status: statusMatch[1].toLowerCase(),
      score: parseFloat(statusMatch[2]),
    };
  }

  const scoreMatch = header.match(/score[=:]?\s*([-\d.]+)/i);
  if (scoreMatch) {
    const score = parseFloat(scoreMatch[1]);
    return {
      score,
      status: score > 5 ? 'spam' : 'ham',
    };
  }

  return null;
}

/** Parse the X-Spam-LLM header: "LEGITIMATE (explanation)" / "SPAM (...)". */
export function parseSpamLLM(header: string): { verdict: string; explanation: string } | null {
  const trimmed = header.trim();
  const match = trimmed.match(/^(LEGITIMATE|SPAM|SUSPICIOUS)\s*\((.+)\)\s*$/i);
  if (match) {
    return {
      verdict: match[1].toUpperCase(),
      explanation: match[2].trim(),
    };
  }
  return null;
}

export interface ListHeaders {
  listId?: string;
  listUnsubscribe?: UnsubscribeUrls;
  /** RFC 8058: present when the http URL accepts a one-click POST. */
  listUnsubscribePost?: string;
  listHelp?: string;
  listPost?: string;
}

/** Extract list headers (List-Unsubscribe, List-Id, ...). */
export function extractListHeaders(headers: Record<string, string | string[]>): ListHeaders {
  const result: ListHeaders = {};
  const first = (key: string): string | undefined => {
    const found = Object.keys(headers).find((k) => k.toLowerCase() === key.toLowerCase());
    if (!found) return undefined;
    const v = headers[found];
    return Array.isArray(v) ? v[0] : v;
  };

  const listId = first('List-Id');
  if (listId) result.listId = listId;

  const unsub = first('List-Unsubscribe');
  if (unsub) {
    const parsed = parseUnsubscribeUrls(unsub);
    if (parsed.preferred) result.listUnsubscribe = parsed;
  }

  const post = first('List-Unsubscribe-Post');
  if (post) result.listUnsubscribePost = post;

  const help = first('List-Help');
  if (help) result.listHelp = help;

  const listPost = first('List-Post');
  if (listPost) result.listPost = listPost;

  return result;
}

export interface EmailHeaderInfo {
  auth?: AuthenticationResults;
  spamScore?: { score: number; status: string } | null;
  spamLLM?: { verdict: string; explanation: string } | null;
  list: ListHeaders;
  /** Bare address from Disposition-Notification-To, when a receipt was requested. */
  readReceiptRequestedBy: string | null;
  /** `<...>`-stripped Message-ID header, for dedupe keys. */
  messageId: string | null;
  /** Set when the server's checks don't back the From address's domain. */
  senderVerification: SenderVerification | null;
}

/** Everything the reader derives from a message's raw headers, in one pass. */
export function deriveHeaderInfo(
  email: Pick<Email, 'headers' | 'messageId'> & Partial<Pick<Email, 'from'>>,
): EmailHeaderInfo {
  const headers = email.headers;
  const authHeaders = headerValues(headers, 'Authentication-Results');
  // The last hop's results are prepended, so the first header is the
  // receiving server's own verdict; the parser trusts that one for DKIM/DMARC.
  const auth = authHeaders.length ? parseAuthenticationResults(authHeaders) : undefined;

  const spamRaw = headerValue(headers, 'X-Spam-Status')
    ?? headerValue(headers, 'X-Spam-Result')
    ?? headerValue(headers, 'X-Spam-Score');
  const spamScore = spamRaw ? parseSpamScore(spamRaw) : null;
  const llmRaw = headerValue(headers, 'X-Spam-LLM');
  const spamLLM = llmRaw ? parseSpamLLM(llmRaw) : null;

  const list = extractListHeaders(headersToRecord(headers));

  const dnt = headerValue(headers, 'Disposition-Notification-To');
  let readReceiptRequestedBy: string | null = null;
  if (dnt) {
    const m = dnt.match(/<([^>]+)>/);
    const addr = (m ? m[1] : dnt).trim();
    readReceiptRequestedBy = addr || null;
  }

  const rawId = email.messageId?.[0] ?? headerValue(headers, 'Message-ID') ?? null;
  const messageId = rawId ? rawId.trim().replace(/^<|>$/g, '') : null;

  const senderVerification = getSenderVerification(auth, email.from?.[0]?.email);

  return { auth, spamScore, spamLLM, list, readReceiptRequestedBy, messageId, senderVerification };
}

/** Milliseconds between the Date header and delivery, or null when unknown. */
export function deliveryDeltaMs(email: Pick<Email, 'sentAt' | 'receivedAt'>): number | null {
  if (!email.sentAt || !email.receivedAt) return null;
  const sent = Date.parse(email.sentAt);
  const received = Date.parse(email.receivedAt);
  if (Number.isNaN(sent) || Number.isNaN(received)) return null;
  return received - sent;
}

/** "2 h 5 min" style rendering of a positive delta. */
export function formatDelta(ms: number): string {
  const totalMinutes = Math.round(Math.abs(ms) / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} d`);
  if (hours) parts.push(`${hours} h`);
  if (minutes || parts.length === 0) parts.push(`${minutes} min`);
  return parts.join(' ');
}
