// MIME building and parsing for PGP and S/MIME mail (#58). Ports of the
// webmail plugins' builders and parsers:
//   repos/plugins/smime/src/mime-builder.js  (entity + header builder)
//   repos/plugins/smime/src/mime-parse.js    (byte-exact multipart split)
//   repos/plugins/bulwark-gpg/src/pgp-mime.js (RFC 3156 wrappers)
// Everything works on "binary strings" (one char per byte, latin1) so a
// signed part can be cut out byte for byte. All line endings are CRLF.

const CRLF = '\r\n';

export interface MimeAddress {
  name?: string;
  email: string;
}

export interface MimeAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  cid?: string;
}

export interface MimeMessageInput {
  from: MimeAddress;
  to: MimeAddress[];
  cc?: MimeAddress[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  attachments?: MimeAttachment[];
  inReplyTo?: string | string[];
  references?: string | string[];
  messageId?: string;
  date?: Date;
  /** Extra header lines, already formatted (`Name: value`). */
  extraHeaders?: string[];
}

// ── bytes <-> binary strings ─────────────────────────────────────────

export function bytesToBinary(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return s;
}

export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function base64Encode(bytes: Uint8Array, lineLength = 76): string {
  const b64 = btoa(bytesToBinary(bytes));
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += lineLength) lines.push(b64.slice(i, i + lineLength));
  return lines.join(CRLF);
}

export function base64Decode(s: string): Uint8Array {
  return binaryToBytes(atob(s.replace(/[^A-Za-z0-9+/=]/g, '')));
}

/** LF or CR line endings to CRLF (RFC 3156 / RFC 8551 canonical form). */
export function toCrlf(s: string): string {
  return s.replace(/\r\n|\r|\n/g, CRLF);
}

// ── building ─────────────────────────────────────────────────────────

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function generateBoundary(): string {
  return `----=_Part_${randomHex(16)}`;
}

/** Collapse CR/LF/tabs (folding leftovers, user input) to single spaces. */
function unfold(value: string | undefined): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** One address for a header: the name quoted (or RFC 2047-encoded) so commas in it stay inside. */
export function formatAddress(addr: MimeAddress): string {
  if (addr.name) {
    const name = unfold(addr.name);
    // Raw 8-bit in a header is rejected by some MTAs; encode it.
    if (!/^[\x20-\x7e]*$/.test(name)) return `${encodeHeaderWords(name)} <${addr.email}>`;
    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}" <${addr.email}>`;
  }
  return addr.email;
}

/** Normalise one id or a list of ids to "<a@b> <c@d>"; empty string if none. */
function msgIdList(value: string | string[] | undefined): string {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .flatMap((v) => unfold(v).split(' '))
    .map((v) => v.replace(/^<+|>+$/g, ''))
    .filter((v) => v.includes('@'))
    .map((v) => `<${v}>`)
    .join(' ');
}

function messageIdDomain(from: MimeAddress): string {
  const domain = String(from?.email ?? '').split('@')[1];
  return domain && /^[A-Za-z0-9.-]+$/.test(domain) ? domain : 'localhost';
}

/** Fold a header at whitespace only (RFC 5322 §2.2.3); words are never split. */
export function formatHeader(name: string, value: string): string {
  const words = unfold(value).split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = `${name}:`;
  for (const word of words) {
    if (line.length + 1 + word.length > 76 && line.length > name.length + 1) {
      lines.push(line);
      line = ` ${word}`;
    } else {
      line += ` ${word}`;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

/** RFC 2047 Q encoded-words, split between whole characters. */
export function encodeHeaderWords(value: string): string {
  const text = unfold(value);
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const prefix = '=?UTF-8?Q?';
  const words: string[] = [];
  let current = '';
  for (const ch of text) {
    const enc = Array.from(utf8(ch))
      .map((b) =>
        (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)
          ? String.fromCharCode(b)
          : b === 0x20
            ? '_'
            : '=' + b.toString(16).toUpperCase().padStart(2, '0'),
      )
      .join('');
    if (prefix.length + current.length + enc.length + 2 > 60) {
      words.push(`${prefix}${current}?=`);
      current = '';
    }
    current += enc;
  }
  if (current) words.push(`${prefix}${current}?=`);
  return words.join(' ');
}

function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value.replace(/"/g, '');
  const encoded = Array.from(utf8(value))
    .map((b) => ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)
      ? String.fromCharCode(b)
      : '=' + b.toString(16).toUpperCase().padStart(2, '0')))
    .join('');
  return `=?UTF-8?Q?${encoded}?=`;
}

function formatDate(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${days[date.getUTCDay()]}, ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} `
    + `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} +0000`;
}

/** The message's own header lines (no MIME-Version / Content-*). */
export function messageHeaderLines(input: MimeMessageInput): string[] {
  const lines: string[] = [];
  lines.push(formatHeader('From', formatAddress(input.from)));
  if (input.to.length) lines.push(formatHeader('To', input.to.map(formatAddress).join(', ')));
  if (input.cc?.length) lines.push(formatHeader('Cc', input.cc.map(formatAddress).join(', ')));
  lines.push(formatHeader('Subject', encodeHeaderWords(input.subject)));
  lines.push(formatHeader('Date', formatDate(input.date ?? new Date())));
  const messageId = input.messageId
    ? `<${input.messageId.replace(/^<+|>+$/g, '')}>`
    : `<${randomHex(16)}@${messageIdDomain(input.from)}>`;
  lines.push(formatHeader('Message-ID', messageId));
  const inReplyTo = msgIdList(input.inReplyTo);
  if (inReplyTo) lines.push(formatHeader('In-Reply-To', inReplyTo));
  const references = msgIdList(input.references);
  if (references) lines.push(formatHeader('References', references));
  for (const h of input.extraHeaders ?? []) lines.push(h);
  return lines;
}

/** Quoted-printable (RFC 2045), trailing whitespace encoded. */
export function quotedPrintableEncode(input: string): string {
  const bytes = utf8(input);
  const lines: string[] = [];
  let line = '';
  const hardLine = (l: string): string[] => {
    const last = l[l.length - 1];
    if (last !== ' ' && last !== '\t') return [l];
    const escaped = last === ' ' ? '=20' : '=09';
    const rest = l.slice(0, -1);
    return rest.length + escaped.length > 76 ? [rest + '=', escaped] : [rest + escaped];
  };
  for (const b of bytes) {
    if (b === 0x0a) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      lines.push(...hardLine(line));
      line = '';
      continue;
    }
    const encoded = b === 0x0d || b === 0x09 || (b >= 0x20 && b <= 0x7e && b !== 0x3d)
      ? String.fromCharCode(b)
      : '=' + b.toString(16).toUpperCase().padStart(2, '0');
    if (line.length + encoded.length > 75) {
      lines.push(line + '=');
      line = encoded;
    } else {
      line += encoded;
    }
  }
  lines.push(...hardLine(line));
  return lines.join(CRLF);
}

function textPartLines(type: 'plain' | 'html', body: string): string[] {
  return [
    `Content-Type: text/${type}; charset=utf-8`,
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintableEncode(body),
  ];
}

function entityLines(input: MimeMessageInput): string[] {
  const hasText = !!input.textBody;
  const hasHtml = !!input.htmlBody;
  const attachments = input.attachments ?? [];
  const bodyLines = (): string[] => {
    if (hasText && hasHtml) {
      const alt = generateBoundary();
      return [
        `Content-Type: multipart/alternative; boundary="${alt}"`,
        '',
        `--${alt}`,
        ...textPartLines('plain', input.textBody!),
        `--${alt}`,
        ...textPartLines('html', input.htmlBody!),
        `--${alt}--`,
      ];
    }
    if (hasHtml) return textPartLines('html', input.htmlBody!);
    return textPartLines('plain', input.textBody ?? '');
  };
  if (attachments.length === 0) return bodyLines();

  const boundary = generateBoundary();
  const lines = [`Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...bodyLines()];
  for (const att of attachments) {
    lines.push(`--${boundary}`);
    const name = encodeHeaderValue(att.filename);
    lines.push(`Content-Type: ${att.contentType || 'application/octet-stream'}; name="${name}"`);
    lines.push(`Content-Disposition: ${att.cid ? 'inline' : 'attachment'}; filename="${name}"`);
    lines.push('Content-Transfer-Encoding: base64');
    if (att.cid) lines.push(`Content-ID: <${att.cid.replace(/^<+|>+$/g, '')}>`);
    lines.push('');
    lines.push(base64Encode(att.content));
  }
  lines.push(`--${boundary}--`);
  return lines;
}

/** The body entity (Content-* headers + body): what gets signed or encrypted. */
export function buildMimeEntity(input: MimeMessageInput): Uint8Array {
  return utf8(entityLines(input).join(CRLF));
}

/** A complete plain MIME message (the payload opaque S/MIME signs). */
export function buildMimeMessage(input: MimeMessageInput): Uint8Array {
  return utf8([...messageHeaderLines(input), 'MIME-Version: 1.0', ...entityLines(input)].join(CRLF));
}

/** RFC 3156 multipart/encrypted around an armored PGP MESSAGE. */
export function wrapPgpEncrypted(armoredCiphertext: string, input: MimeMessageInput): Uint8Array {
  const boundary = generateBoundary();
  const lines = [
    ...messageHeaderLines(input),
    'MIME-Version: 1.0',
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted";`,
    ` boundary="${boundary}"`,
    '',
    'This is an OpenPGP/MIME encrypted message (RFC 3156).',
    '',
    `--${boundary}`,
    'Content-Type: application/pgp-encrypted',
    'Content-Description: PGP/MIME version identification',
    '',
    'Version: 1',
    '',
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    'Content-Description: OpenPGP encrypted message',
    'Content-Disposition: inline; filename="encrypted.asc"',
    '',
    toCrlf(armoredCiphertext).replace(/\r\n$/, ''),
    `--${boundary}--`,
    '',
  ];
  return utf8(lines.join(CRLF));
}

/** RFC 3156 multipart/signed: `entity` must be the exact bytes that were signed. */
export function wrapPgpSigned(entity: Uint8Array, armoredSignature: string, input: MimeMessageInput, micalg = 'pgp-sha256'): Uint8Array {
  const boundary = generateBoundary();
  const head = [
    ...messageHeaderLines(input),
    'MIME-Version: 1.0',
    `Content-Type: multipart/signed; micalg="${micalg}"; protocol="application/pgp-signature";`,
    ` boundary="${boundary}"`,
    '',
    'This is an OpenPGP/MIME signed message (RFC 3156).',
    '',
    `--${boundary}`,
    '',
  ].join(CRLF);
  const tail = [
    '',
    `--${boundary}`,
    'Content-Type: application/pgp-signature; name="signature.asc"',
    'Content-Description: OpenPGP digital signature',
    'Content-Disposition: attachment; filename="signature.asc"',
    '',
    toCrlf(armoredSignature).replace(/\r\n$/, ''),
    `--${boundary}--`,
    '',
  ].join(CRLF);
  return concat(utf8(head), entity, utf8(tail));
}

/** Opaque S/MIME (application/pkcs7-mime) around CMS DER. */
export function wrapCmsMessage(cms: Uint8Array, smimeType: 'signed-data' | 'enveloped-data', input: MimeMessageInput): Uint8Array {
  const lines = [
    ...messageHeaderLines(input),
    'MIME-Version: 1.0',
    `Content-Type: application/pkcs7-mime; smime-type=${smimeType}; name="smime.p7m"`,
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="smime.p7m"',
  ];
  // A blank line (CRLFCRLF) ends the header block before the base64 body.
  return utf8(lines.join(CRLF) + CRLF + CRLF + base64Encode(cms) + CRLF);
}

/** A CMS blob as a nested MIME entity (S/MIME sign-then-encrypt). */
export function cmsInnerEntity(cms: Uint8Array, smimeType: 'signed-data'): Uint8Array {
  return utf8([
    `Content-Type: application/pkcs7-mime; smime-type=${smimeType}; name="smime.p7m"`,
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="smime.p7m"',
    '',
    base64Encode(cms),
    '',
  ].join(CRLF));
}

/** multipart/signed with a detached CMS signature (RFC 8551 §3.5.3). */
export function wrapSmimeDetached(entity: Uint8Array, signatureDer: Uint8Array, input: MimeMessageInput): Uint8Array {
  const boundary = generateBoundary();
  const head = [
    ...messageHeaderLines(input),
    'MIME-Version: 1.0',
    'Content-Type: multipart/signed; protocol="application/pkcs7-signature";',
    ` micalg=sha-256; boundary="${boundary}"`,
    '',
    'This is a cryptographically signed message in MIME format.',
    '',
    `--${boundary}`,
    '',
  ].join(CRLF);
  // The CRLF before a boundary belongs to the boundary (RFC 2046 §5.1.1).
  const tail = [
    '',
    `--${boundary}`,
    'Content-Type: application/pkcs7-signature; name="smime.p7s"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="smime.p7s"',
    '',
    base64Encode(signatureDer),
    `--${boundary}--`,
    '',
  ].join(CRLF);
  return concat(utf8(head), entity, utf8(tail));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

// ── parsing ──────────────────────────────────────────────────────────

export interface MimeNode {
  type: string;
  params: Record<string, string>;
  headers: Record<string, string>;
  cte: string;
  body: string;
  /** The exact entity (headers + body) as a binary string. */
  raw: string;
  children: MimeNode[];
}

function parseHeaders(headerText: string): Record<string, string> {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

export function parseContentType(value: string): { type: string; params: Record<string, string> } {
  const parts = value.split(';');
  const type = parts[0].trim().toLowerCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq < 0) continue;
    const k = parts[i].slice(0, eq).trim().toLowerCase();
    let v = parts[i].slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { type, params };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split a multipart body into the exact bytes of each part. The CRLF before a
 * delimiter belongs to the delimiter, not the part (RFC 2046 §5.1.1), which
 * is what a detached signature covers.
 */
function splitMultipart(body: string, boundary: string): string[] {
  const delim = new RegExp(`(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*(?:\\r?\\n|$)`, 'g');
  const marks: Array<{ index: number; end: number; closing: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = delim.exec(body))) {
    marks.push({ index: m.index, end: delim.lastIndex, closing: !!m[1] });
    if (m[0].length === 0) delim.lastIndex++;
  }
  const parts: string[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    if (marks[i].closing) break;
    parts.push(body.slice(marks[i].end, marks[i + 1].index));
  }
  return parts;
}

/** Parse an entity (binary string) into a tree. */
export function parseEntity(raw: string): MimeNode {
  const sep = raw.match(/\r?\n\r?\n/);
  const headerText = sep && sep.index !== undefined ? raw.slice(0, sep.index) : raw;
  const body = sep && sep.index !== undefined ? raw.slice(sep.index + sep[0].length) : '';
  // An entity that starts with the blank line has no headers at all.
  const headers = /^\r?\n/.test(raw) ? {} : parseHeaders(headerText);
  const realBody = /^\r?\n/.test(raw) ? raw.replace(/^\r?\n/, '') : body;
  const { type, params } = parseContentType(headers['content-type'] || 'text/plain');
  const cte = (headers['content-transfer-encoding'] || '7bit').trim().toLowerCase();
  const node: MimeNode = { type, params, headers, cte, body: realBody, raw, children: [] };
  if (type.startsWith('multipart/') && params.boundary) {
    node.children = splitMultipart(realBody, params.boundary).map(parseEntity);
  }
  return node;
}

function qpDecode(input: string): Uint8Array {
  const out: number[] = [];
  const cleaned = input.replace(/=\r?\n/g, '');
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === '=' && i + 2 < cleaned.length + 1) {
      const hex = cleaned.substr(i + 1, 2);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(cleaned.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}

/** A leaf's decoded body bytes. */
export function decodeBody(node: MimeNode): Uint8Array {
  if (node.cte === 'base64') {
    try {
      return base64Decode(node.body);
    } catch {
      return new Uint8Array(0);
    }
  }
  if (node.cte === 'quoted-printable') return qpDecode(node.body);
  return binaryToBytes(node.body);
}

/** Depth-first search for the first node that matches. */
export function findNode(node: MimeNode, match: (n: MimeNode) => boolean): MimeNode | null {
  if (match(node)) return node;
  for (const child of node.children) {
    const found = findNode(child, match);
    if (found) return found;
  }
  return null;
}
