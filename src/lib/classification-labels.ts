/**
 * Classification labels (policy `organisation.labels`, webmail 1.20
 * enterprise pack item 3). Port of the webmail's lib/classification/labels.ts
 * and the pure parts of lib/outgoing/classification.ts, plus the labels
 * section of lib/admin/organisation-policy.ts (sanitizeLabels,
 * normaliseMerged), since the app keeps the policy's `organisation` part as
 * the webmail sent it.
 *
 * Headers a sent message carries:
 * - `SIO-Label` (RFC 7444) in the marking-only form with colours, as a raw
 *   header: `marking="CONFIDENTIAL"; fgcolor=#000000; bgcolor=#d97706`. A
 *   marking with non-ASCII characters uses RFC 2231
 *   (`marking*=utf-8''VS-NUR%20F%C3%9CR...`).
 * - `Sensitivity` (RFC 2156 §5.3.4), what Outlook shows, when the label
 *   sets one.
 * - The admin's extra header (X-Classification, msip_labels) when the label
 *   has a value for it.
 * The subject gets the label's prefix, once. A draft keeps the user's choice
 * in `X-Bulwark-Label` (the label id, or `none` for "no label"), the way it
 * keeps the priority.
 */

import { stripSubjectPrefixes } from './subject-prefix';
import { decodeByHand } from './structured-mail/utf8';

/** RFC 2156 Sensitivity values (what Outlook shows); '' writes none. */
export const LABEL_SENSITIVITIES = ['', 'Personal', 'Private', 'Company-Confidential'] as const;
export type LabelSensitivity = (typeof LABEL_SENSITIVITIES)[number];

export interface ClassificationLabel {
  id: string;
  name: string;
  /** #rrggbb */
  color: string;
  description: string;
  /** The SIO-Label `marking` (RFC 7444); the name when empty. */
  marking: string;
  sensitivity: LabelSensitivity;
  /** Added in front of the subject, e.g. "[Confidential]"; '' for none. */
  subjectPrefix: string;
  /** Value of the admin's extra header for this label; '' writes none. */
  extraHeaderValue: string;
}

export interface LabelsPolicy {
  /** [] turns classification labels off. */
  list: ClassificationLabel[];
  /** The label new messages start with; '' for none. */
  defaultId: string;
  /** Sending needs a label. Dropped when the list is empty. */
  required: boolean;
  /** Name of an extra header each label may set (e.g. X-Classification); '' for none. */
  extraHeader: string;
}

export const NO_LABELS: LabelsPolicy = { list: [], defaultId: '', required: false, extraHeader: '' };

export const SIO_LABEL_HEADER = 'SIO-Label';
export const SENSITIVITY_HEADER = 'Sensitivity';
export const DRAFT_LABEL_HEADER = 'X-Bulwark-Label';
/** A draft whose sender picked "no label". */
export const NO_LABEL = 'none';

// ─── The policy section ─────────────────────────────────────

const MAX_LABELS = 50;
const MAX_TEXT = 64 * 1024;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
// RFC 5322 field-name: printable ASCII but the colon.
const HEADER_NAME_RE = /^[\x21-\x39\x3b-\x7e]{1,76}$/;
const RESERVED_HEADER_PREFIXES = ['content-', 'list-', 'resent-', 'arc-'];
const RESERVED_HEADERS = new Set([
  'from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'sender', 'reply-to', 'in-reply-to',
  'references', 'mime-version', 'content-type', 'content-transfer-encoding', 'content-disposition',
  'received', 'return-path', 'dkim-signature', 'arc-seal', 'arc-message-signature', 'authentication-results',
  'sio-label', 'sio-label-history', 'sensitivity', 'x-bulwark-label', 'auto-submitted', 'precedence', 'importance', 'x-priority', 'disposition-notification-to',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Text for a header value or a one-line field: no line breaks or control characters. */
function line(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.slice(0, MAX_TEXT).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function itemId(value: unknown): string | null {
  return typeof value === 'string' && ID_RE.test(value.trim()) ? value.trim() : null;
}

function headerName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (!HEADER_NAME_RE.test(v)) return '';
  const lower = v.toLowerCase();
  if (RESERVED_HEADERS.has(lower) || RESERVED_HEADER_PREFIXES.some((p) => lower.startsWith(p))) return '';
  return v;
}

function sanitizeLabel(item: unknown, seen: Set<string>): ClassificationLabel | null {
  if (!isRecord(item)) return null;
  const id = itemId(item.id);
  const name = line(item.name, 100);
  if (!id || seen.has(id) || !name) return null;
  seen.add(id);
  const sensitivity = (LABEL_SENSITIVITIES as readonly unknown[]).includes(item.sensitivity)
    ? (item.sensitivity as LabelSensitivity)
    : '';
  return {
    id,
    name,
    color: typeof item.color === 'string' && COLOR_RE.test(item.color.trim()) ? item.color.trim().toLowerCase() : '#6b7280',
    description: typeof item.description === 'string' ? item.description.slice(0, 1000) : '',
    // A quoted header parameter: no double quotes or backslashes.
    marking: line(item.marking, 200).replace(/["\\]/g, ''),
    sensitivity,
    subjectPrefix: line(item.subjectPrefix, 60),
    extraHeaderValue: line(item.extraHeaderValue, 500),
  };
}

/**
 * The labels section of a policy's `organisation` part, checked: unknown
 * keys and broken labels dropped, a default that isn't in the list and a
 * "required" without labels cleared (webmail normaliseMerged).
 */
export function labelsPolicyOf(organisation: unknown): LabelsPolicy {
  const raw = isRecord(organisation) && isRecord(organisation.labels) ? organisation.labels : null;
  if (!raw) return NO_LABELS;
  const seen = new Set<string>();
  const list: ClassificationLabel[] = [];
  for (const item of Array.isArray(raw.list) ? raw.list : []) {
    const label = sanitizeLabel(item, seen);
    if (label) list.push(label);
    if (list.length >= MAX_LABELS) break;
  }
  const defaultId = itemId(raw.defaultId) ?? '';
  return {
    list,
    defaultId: list.some((l) => l.id === defaultId) ? defaultId : '',
    required: raw.required === true && list.length > 0,
    extraHeader: headerName(raw.extraHeader),
  };
}

// ─── Writing ────────────────────────────────────────────────

/** The marking a label writes: its own, else its name. */
export function labelMarking(label: Pick<ClassificationLabel, 'marking' | 'name'>): string {
  return (label.marking || label.name).trim();
}

/** Black or white, whichever reads better on `bg` (#rrggbb). */
export function textColorOn(bg: string): '#000000' | '#ffffff' {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg);
  if (!m) return '#ffffff';
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

// RFC 2231 attribute-char: anything but specials, space, controls, *, ' and %.
const ATTRIBUTE_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function percentEncode(value: string): string {
  let out = '';
  for (const byte of utf8Bytes(value)) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && ATTRIBUTE_CHAR.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** The marking parameter(s): quoted when ASCII, RFC 2231 (with continuations when long) otherwise. */
function markingParameters(marking: string): string[] {
  const clean = marking.replace(/["\\\r\n]/g, '');
  if (/^[\x20-\x7e]*$/.test(clean)) return [`marking="${clean}"`];
  const encoded = percentEncode(clean);
  const MAX = 60;
  if (encoded.length + 15 <= MAX) return [`marking*=utf-8''${encoded}`];
  // Split between encoded characters, never inside a %XX.
  const units = encoded.match(/%[0-9A-F]{2}|[^%]/g) ?? [];
  const pieces: string[] = [];
  let piece = '';
  for (const unit of units) {
    if (piece.length + unit.length > MAX - 15) {
      pieces.push(piece);
      piece = '';
    }
    piece += unit;
  }
  if (piece) pieces.push(piece);
  return pieces.map((p, i) => (i === 0 ? `marking*0*=utf-8''${p}` : `marking*${i}*=${p}`));
}

/** The SIO-Label value after "SIO-Label:", folded (leading space included). */
export function sioLabelValue(label: Pick<ClassificationLabel, 'marking' | 'name' | 'color'>): string {
  const params = [...markingParameters(labelMarking(label)), `fgcolor=${textColorOn(label.color)}`, `bgcolor=${label.color}`];
  // "SIO-Label: " is 11 characters; fold between parameters past 78.
  let col = 11;
  let out = '';
  params.forEach((param, i) => {
    const piece = i === params.length - 1 ? param : `${param};`;
    if (i > 0 && col + 1 + piece.length > 78) {
      out += `\r\n ${piece}`;
      col = 1 + piece.length;
    } else {
      out += ` ${piece}`;
      col += 1 + piece.length;
    }
  });
  return out;
}

function labelHeaderPairs(label: ClassificationLabel, extraHeader: string): Array<[string, string, 'raw' | 'text']> {
  const pairs: Array<[string, string, 'raw' | 'text']> = [[SIO_LABEL_HEADER, sioLabelValue(label), 'raw']];
  if (label.sensitivity) pairs.push([SENSITIVITY_HEADER, label.sensitivity, 'text']);
  const extraValue = label.extraHeaderValue.trim();
  if (extraHeader && extraValue) pairs.push([extraHeader, extraValue, 'text']);
  return pairs;
}

/** The label's headers as JMAP Email/set create properties (RFC 8621 §4.1.3). */
export function labelHeaderProperties(label: ClassificationLabel, extraHeader: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value, form] of labelHeaderPairs(label, extraHeader)) {
    // The server writes "Name: " itself; a raw value keeps only its own folds.
    out[form === 'raw' ? `header:${name}:asRaw` : `header:${name}:asText`] = form === 'raw' ? value.trimStart() : value;
  }
  return out;
}

function base64OfBytes(bytes: number[]): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * A header value for raw MIME, folded under 78 columns: ASCII as it is,
 * folded between words; anything else as RFC 2047 encoded words of at most
 * 75 characters each, split between characters.
 */
function foldedValue(name: string, value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    let col = name.length + 1;
    let out = '';
    for (const word of value.split(' ')) {
      if (out && col + 1 + word.length > 78) {
        out += `\r\n ${word}`;
        col = 1 + word.length;
      } else {
        out += ` ${word}`;
        col += 1 + word.length;
      }
    }
    return out;
  }
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length === 0) return;
    words.push(`=?UTF-8?B?${base64OfBytes(chunk)}?=`);
    chunk = [];
  };
  const firstLimit = Math.max(3, Math.min(45, Math.floor((78 - name.length - 2 - 12) / 4) * 3));
  for (const char of value) {
    const bytes = utf8Bytes(char);
    if (chunk.length + bytes.length > (words.length === 0 ? firstLimit : 45)) flush();
    chunk.push(...bytes);
  }
  flush();
  return ` ${words.join('\r\n ')}`;
}

/** The label's headers as raw header lines (folded with CRLF and a space), for a signed or encrypted message's MIME. */
export function labelHeaderLines(label: ClassificationLabel, extraHeader: string): string[] {
  return labelHeaderPairs(label, extraHeader).map(([name, value, form]) =>
    form === 'raw' ? `${name}:${value}` : `${name}:${foldedValue(name, value)}`);
}

/** The draft marker property: the label id, or `none` for no label; nothing while labels are off (undefined). */
export function draftLabelProperty(choice: string | null | undefined): Record<string, string> {
  if (choice === undefined) return {};
  return { [`header:${DRAFT_LABEL_HEADER}:asText`]: choice ?? NO_LABEL };
}

// ─── Reading ────────────────────────────────────────────────

/** JMAP `headers` (a list) or a name → value record. */
export type HeaderSource = Array<{ name: string; value: string }> | Record<string, string | string[]> | null | undefined;

function header(headers: HeaderSource, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  if (Array.isArray(headers)) {
    const found = headers.find((h) => h?.name?.toLowerCase() === lower && typeof h.value === 'string');
    return found?.value;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') return first;
  }
  return undefined;
}

/**
 * The choice a re-opened draft carries: a label id, null for "no label",
 * undefined when the draft says nothing (another client's, or one saved
 * before labels).
 */
export function draftLabelChoice(headers: HeaderSource): string | null | undefined {
  const value = header(headers, DRAFT_LABEL_HEADER)?.trim();
  if (!value) return undefined;
  return value === NO_LABEL ? null : value;
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  const cs = (charset || 'utf-8').toLowerCase();
  const Decoder = (globalThis as { TextDecoder?: typeof TextDecoder }).TextDecoder;
  if (Decoder) {
    try {
      return new Decoder(cs).decode(bytes);
    } catch { /* an unknown charset: below */ }
  }
  if (cs === 'utf-8' || cs === 'utf8') {
    try {
      return decodeByHand(bytes);
    } catch { /* broken UTF-8: as Latin-1 */ }
  }
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function decodePercent(value: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '%' && /^[0-9a-f]{2}$/i.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i) & 0xff);
    }
  }
  return decodeBytes(Uint8Array.from(bytes), charset);
}

/** Decodes RFC 2047 encoded words a server may have put into a value. */
function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
    try {
      const binary = enc.toLowerCase() === 'b'
        ? atob(text)
        : text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      return decodeBytes(Uint8Array.from(binary, (c) => c.charCodeAt(0)), charset);
    } catch {
      return whole;
    }
  });
}

function splitExtended(value: string): [string, string, string] {
  const first = value.indexOf("'");
  const second = first >= 0 ? value.indexOf("'", first + 1) : -1;
  if (first < 0 || second < 0) return ['utf-8', '', value];
  return [value.slice(0, first), value.slice(first + 1, second), value.slice(second + 1)];
}

/**
 * The `marking` of a raw SIO-Label value (RFC 7444 §2): a quoted or token
 * value, or the RFC 2231 forms (encoded and continued). Null without one.
 */
export function parseSioLabelMarking(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const value = raw.replace(/\r?\n[ \t]+/g, ' ');
  const params = new Map<string, string>();
  const re = /([A-Za-z0-9*-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;\s]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    params.set(m[1].toLowerCase(), v);
  }
  if (params.has('marking')) return decodeEncodedWords(params.get('marking')!).trim() || null;
  if (params.has('marking*')) {
    const [charset, , text] = splitExtended(params.get('marking*')!);
    return decodePercent(text, charset).trim() || null;
  }
  // Continuations: marking*0*, marking*1, ... joined before decoding (a
  // character's bytes may be split across two of them, RFC 2231 §4.1).
  let joinedEncoded = '';
  let charset = 'utf-8';
  for (let i = 0; i < 100; i++) {
    const encoded = params.get(`marking*${i}*`);
    const plain = params.get(`marking*${i}`);
    if (encoded === undefined && plain === undefined) break;
    if (encoded !== undefined) {
      let text = encoded;
      if (i === 0) [charset, , text] = splitExtended(encoded);
      joinedEncoded += text;
    } else {
      joinedEncoded += percentEncode(plain!);
    }
  }
  return decodePercent(joinedEncoded, charset).trim() || null;
}

const normalise = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The known label a received message carries: by its SIO-Label marking
 * first, then by the admin's extra header value. Unknown values show
 * nothing. Information only: anyone can write these headers.
 */
export function receivedLabel(headers: HeaderSource, policy: LabelsPolicy | null | undefined): ClassificationLabel | null {
  if (!policy || policy.list.length === 0) return null;
  const marking = parseSioLabelMarking(header(headers, SIO_LABEL_HEADER));
  if (marking) {
    const wanted = normalise(marking);
    const byMarking = policy.list.find((label) => normalise(labelMarking(label)) === wanted);
    if (byMarking) return byMarking;
  }
  if (policy.extraHeader) {
    const raw = header(headers, policy.extraHeader);
    if (raw) {
      const wanted = normalise(decodeEncodedWords(raw.replace(/\r?\n[ \t]+/g, ' ')));
      const byExtra = policy.list.find((label) => label.extraHeaderValue && normalise(label.extraHeaderValue) === wanted);
      if (byExtra) return byExtra;
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The subject with `label`'s prefix in front, once: every known label
 * prefix in the leading chain of reply and forward prefixes is taken out
 * first ("Re: [Confidential] x" → "[Strictly confidential] Re: x"), so a
 * reply doesn't double it and a changed label replaces the old one.
 */
export function applyLabelPrefix(subject: string, label: ClassificationLabel | null, labels: ClassificationLabel[]): string {
  const prefixes = [...new Set(labels.map((l) => l.subjectPrefix.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  let rest = subject.trimStart();
  const kept: string[] = [];
  const labelRes = prefixes.map((p) => new RegExp(`^${escapeRegExp(p)}(?:\\s*:)?(?:\\s+|$)`, 'i'));
  for (let i = 0; i < 40; i++) {
    const labelMatch = labelRes.map((re) => re.exec(rest)).find(Boolean);
    if (labelMatch) {
      rest = rest.slice(labelMatch[0].length).trimStart();
      continue;
    }
    const stripped = stripSubjectPrefixes(rest);
    if (stripped === rest) break;
    // Keep the reply/forward prefix as written, one token at a time.
    const token = rest.slice(0, rest.length - stripped.length);
    const one = /^\s*[^:：]+[:：]\s*/.exec(token)?.[0] ?? token;
    kept.push(one.trim());
    rest = rest.slice(one.length).trimStart();
  }
  const chain = [...kept, rest].filter(Boolean).join(' ');
  const prefix = label?.subjectPrefix.trim();
  return prefix ? (chain ? `${prefix} ${chain}` : prefix) : chain;
}

let extraHeaderNames: () => readonly string[] = () => [];

/** Hands in the extra header names the organisation's labels use (lib/outgoing/classification registers it). */
export function registerLabelHeaderNames(provider: () => readonly string[]): void {
  extraHeaderNames = provider;
}

/**
 * The headers a reply or a reopened draft needs for its label: SIO-Label,
 * the draft marker and every extra header name any scope of the policy
 * uses. Small enough to keep in the composer's route params.
 */
export function labelSourceHeaders(headers: Array<{ name: string; value: string }> | null | undefined): Array<{ name: string; value: string }> | undefined {
  if (!Array.isArray(headers) || headers.length === 0) return undefined;
  const names = new Set([SIO_LABEL_HEADER.toLowerCase(), DRAFT_LABEL_HEADER.toLowerCase()]);
  for (const name of extraHeaderNames()) names.add(name.toLowerCase());
  const out = headers.filter((h) => typeof h?.name === 'string' && names.has(h.name.toLowerCase()));
  return out.length > 0 ? out : undefined;
}

// ─── Choosing ───────────────────────────────────────────────

/**
 * The label a reply takes over from its original: the original's known
 * label, only when an internal sender set it (anyone outside can write the
 * header) and never one below the default (the list runs from least to
 * most protected).
 */
export function originalLabel(
  policy: LabelsPolicy,
  original: { headers: HeaderSource; senderInternal: boolean } | null | undefined,
): ClassificationLabel | null {
  if (!original?.headers || policy.list.length === 0) return null;
  const label = receivedLabel(original.headers, policy);
  if (!label || !original.senderInternal) return null;
  const floor = policy.list.findIndex((l) => l.id === policy.defaultId);
  return floor >= 0 && policy.list.indexOf(label) < floor ? null : label;
}

/**
 * The label a message goes out with. `choice`: the user's pick (an id),
 * null for "no label", undefined when they picked nothing, which takes the
 * original's label, else the default. A pick that isn't in the list counts
 * as nothing picked.
 */
export function resolveLabel(
  policy: LabelsPolicy,
  choice: string | null | undefined,
  original?: { headers: HeaderSource; senderInternal: boolean } | null,
): ClassificationLabel | null {
  if (policy.list.length === 0) return null;
  if (choice === null) return null;
  const picked = choice ? policy.list.find((label) => label.id === choice) : undefined;
  if (picked) return picked;
  return originalLabel(policy, original) ?? policy.list.find((label) => label.id === policy.defaultId) ?? null;
}

/** Whether sending needs a label that `label` doesn't give. */
export function labelMissing(policy: LabelsPolicy, label: ClassificationLabel | null): boolean {
  return policy.required && policy.list.length > 0 && !label;
}

/** A send stopped because the organisation requires a label and none was picked. */
export class LabelRequiredError extends Error {
  constructor() {
    super('A classification label is required');
    this.name = 'LabelRequiredError';
  }
}

/** What a labelled message carries: the prefixed subject and the label's headers. */
export interface LabelledOutgoing {
  subject: string;
  /** JMAP Email/set create properties. */
  headers?: Record<string, string>;
  /** The same as raw header lines, for a message whose MIME the app builds (signed or encrypted). */
  headerLines?: string[];
}

/**
 * The send stage (webmail classifyOutgoing): the subject with the label's
 * prefix (once) and the label's headers. Throws LabelRequiredError when the
 * policy requires a label and there is none.
 */
export function classifyOutgoing(policy: LabelsPolicy, label: ClassificationLabel | null, subject: string): LabelledOutgoing {
  if (policy.list.length === 0) return { subject };
  if (labelMissing(policy, label)) throw new LabelRequiredError();
  return {
    subject: applyLabelPrefix(subject, label, policy.list),
    ...(label ? {
      headers: labelHeaderProperties(label, policy.extraHeader),
      headerLines: labelHeaderLines(label, policy.extraHeader),
    } : {}),
  };
}
