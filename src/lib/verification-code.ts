import type { Email } from '../api/types';
import { pickEmailBody, selectRenderableHtml } from './email-body';

/**
 * Finds the one-time code in a sign-in or confirmation mail ("Your
 * verification code is 177945", "HUK6QR ist Ihr Bestätigungscode"), so the
 * list and the reader can offer it for copying.
 *
 * A token only counts when it looks like a code and sits near a word that
 * names one (code, Bestätigungscode, Passcode, PIN, OTP, ...). Mail is full
 * of numbers — dates, prices, postcodes, order and phone numbers — and a
 * wrong chip is worse than none, so anything doubtful is left out.
 */

// A code this far after its keyword ("Der Bestätigungscode ist unten
// aufgeführt. Bitte geben Sie ihn ... ein. 37CCHC") still counts, one this far
// before it ("548980 ist Ihr Bestätigungscode") too.
const MAX_AFTER = 120;
const MAX_BEFORE = 60;

// Words that end in a code keyword but name something else: "Gutscheincode",
// "Postcode", "Barcode", and the word before a bare "code" ("promo code",
// "Claude Code", "VS Code").
const NOT_A_CODE_PREFIXES = new Set([
  'en', 'de', 'uni', 'x', 'vs', 'op', 'byte', 'bar', 'post', 'zip', 'qr', 'geo', 'short', 'pseudo',
  'hash', 'leet', 'trans', 're', 'source', 'quell', 'programm', 'program', 'status', 'error',
  'fehler', 'dress', 'color', 'colour', 'farb', 'html', 'css', 'embed', 'tracking', 'sendungs',
  'referral', 'empfehlungs', 'sort', 'swift', 'tax', 'ean', 'produkt', 'product', 'artikel',
  'promo', 'coupon', 'discount', 'voucher', 'gift', 'gutschein', 'rabatt', 'aktions', 'geschenk',
  'bonus', 'vorteils', 'area', 'country', 'länder', 'laender', 'landes', 'claude', 'studio',
]);

// Word endings that name a code, across the languages the app ships.
// "bestätigungscode", "verificatiecode", "engangskode", "vahvistuskoodi",
// "verifieringskod", "ellenőrzőkód", "код", ...
const CODE_WORD_ENDINGS = [
  'code', 'codes', 'codice', 'codici', 'código', 'códigos', 'codigo', 'codigos', 'cod', 'kod',
  'kodu', 'kodem', 'kodunuz', 'kód', 'kódot', 'kódu', 'kode', 'koden', 'koodi', 'koodia', 'kood',
  'kods', 'kodas', 'код', 'кода', 'коду', 'кодом', 'κωδικός', 'κωδικό', 'קוד', 'رمز', 'کد',
];

const CODE_WORDS_EXACT = new Set(['passcode', 'einmalkennwort', 'einmalpasswort']);

// Only ever written in capitals when they mean a code; "pin" and "tan" are
// ordinary words too.
const UPPERCASE_CODE_WORDS = /^(?:PIN|OTP|(?:m|sms|push|chip|photo|i|e)?TAN)$/;

// Scripts without spaces between words, matched as substrings.
const CJK_CODE_WORDS = /コード|認証番号|確認番号|验证码|驗證碼|校验码|动态码|인증\s?번호|인증\s?코드|코드/g;

const ONE_TIME_PASSWORD = /\b(?:one[- ]time|single[- ]use|temporary) pass(?:word|code)\b/gi;

const WORD = /[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*/gu;

// "with code 250 (2.1.5)" in a delivery report: a code word followed by a
// number too short to be a one-time code names a status or error code.
const LABELS_SHORT_NUMBER = /^\s*[:=]?\s*\d{1,3}(?![\p{L}\p{N}]|[.,]\d|[ -]\d)/u;

function isCodeWordPart(part: string, previous: string | undefined): boolean {
  if (UPPERCASE_CODE_WORDS.test(part)) return true;
  const lower = part.toLowerCase();
  if (CODE_WORDS_EXACT.has(lower)) return true;
  for (const ending of CODE_WORD_ENDINGS) {
    if (!lower.endsWith(ending)) continue;
    const prefix = lower.slice(0, lower.length - ending.length);
    // A bare "code" takes its meaning from the word before it.
    const qualifier = prefix || previous?.toLowerCase();
    return !qualifier || !NOT_A_CODE_PREFIXES.has(qualifier);
  }
  return false;
}

interface Span { start: number; end: number }

function findCodeWords(text: string): Span[] {
  const spans: Span[] = [];
  let previousWord: string | undefined;
  for (const match of text.matchAll(WORD)) {
    const start = match.index!;
    const end = start + match[0].length;
    const parts = match[0].split('-');
    const hit = parts.some((part, i) => isCodeWordPart(part, i > 0 ? parts[i - 1] : previousWord));
    const next = text.slice(end, end + 12);
    // "Code of Conduct", "code of practice"
    if (hit && !/^\s+of\s/i.test(next) && !LABELS_SHORT_NUMBER.test(next)) spans.push({ start, end });
    previousWord = parts[parts.length - 1];
  }
  for (const re of [CJK_CODE_WORDS, ONE_TIME_PASSWORD]) {
    for (const match of text.matchAll(re)) {
      spans.push({ start: match.index!, end: match.index! + match[0].length });
    }
  }
  return spans;
}

// Tried in this order at each position, so "557 260" and "6ZA-BRE" are taken
// whole before their pieces are.
const CANDIDATE = new RegExp(
  [
    // 6ZA-BRE, NJF63-SW7S7, and 2025-12-12 (dropped later)
    String.raw`(?<![\p{L}\p{N}])[A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{2,8}){1,3}(?![\p{L}\p{N}])`,
    // 557 260, 123-456
    String.raw`(?<!\d)\d{3,4}[ -]\d{3,4}(?!\d)`,
    // 3 0 4 6 2 7
    String.raw`(?<![\p{L}\p{N}])\d(?: \d){3,9}(?![\p{L}\p{N}])`,
    // 37CCHC, 5aem5f5z, 177945
    String.raw`(?<![\p{L}\p{N}])[A-Za-z0-9]{4,10}(?![\p{L}\p{N}])`,
  ].join('|'),
  'gu',
);

// Digits run into the words around them, which the pass above takes as one
// token: "ein:86771674Teile", "Claude.ai177945Copy", "732888Gib".
const GLUED_DIGITS = /(?<=\p{L})\d{4,10}(?!\d)|(?<!\d)\d{4,10}(?=\p{L})/gu;

const ALNUM = /[\p{L}\p{N}]/u;

/** Whether the digits at start..end have only letters around them, as in
 *  "ai177945Copy", and are not one group of an id like "4887a30a5a2si2098"
 *  or "PAXPR03MB8065". */
function gluedToWords(text: string, start: number, end: number): boolean {
  while (start > 0 && ALNUM.test(text[start - 1])) start--;
  while (end < text.length && ALNUM.test(text[end])) end++;
  return /^\p{L}*\d+\p{L}*$/u.test(text.slice(start, end));
}

const YEAR = /^(?:19|20)\d\d$/;
// 10min, 600px, 100GB
const NUMBER_WITH_UNIT = /^\d+[a-z]{1,3}$/i;
// THANKS10, HERBST25, FALL2026
const PROMO_CODE = /^[A-Z]{4,}\d{1,4}$/;
const PROMO_WORDS = /%|(?<!\p{L})(?:off|rabatt|spar\p{L}*|save|discount|coupon|gutschein\p{L}*|voucher|sale|angebot\p{L}*)(?!\p{L})/iu;
// A number labelled as something else: "Kundennummer: 5512345", "Meeting-ID:
// 845 1234 5678", "at line 1042", "card ending in 4821". Nouns that also
// label codes ("Code für dein Konto: 123456") count only without a colon.
const LABELLED_AS_OTHER = new RegExp(
  String.raw`(?:(?:\p{L}*(?:nummer|number)|(?<!\p{L})(?:nr|no|id|line|zeile|version|tel|telefon|phone|fax|mobil|plz))\.?:?` +
  String.raw`|(?<!\p{L})(?:order|bestellung|account|konto|invoice|rechnung|ticket|case|page|seite|room|zimmer|commit|issue|pr|build|run|job|step|port)` +
  String.raw`|ending in|endet auf|endend auf|ends with)[ #]*$`,
  'iu',
);
const LOWERCASE_HEX = /^[0-9a-f-]+$/;
// "The code is: 123456", "Ihr Code lautet 123456"
const LINKED_BY = /(?::|=|(?<!\p{L})(?:is|lautet|ist|est|es|è|é|är|er|jest|je))\s*$/iu;

const LETTER = /\p{L}/u;

/** Text around a candidate, not starting or ending inside a word, so that
 *  "off" cut from "offiziellen" does not read as a word of its own. */
function contextWindow(text: string, from: number, to: number): string {
  let start = Math.max(0, from);
  let end = Math.min(text.length, to);
  while (start > 0 && start < end && LETTER.test(text[start - 1]) && LETTER.test(text[start])) start++;
  while (end < text.length && end > start && LETTER.test(text[end]) && LETTER.test(text[end - 1])) end--;
  return text.slice(start, end);
}

interface Candidate extends Span { code: string; score: number }

function scoreCandidate(text: string, raw: string, start: number, keywords: Span[]): Candidate | null {
  const end = start + raw.length;
  const letters = raw.replace(/[^A-Za-z]/g, '');
  const digits = raw.replace(/\D/g, '');
  const before = contextWindow(text, start - 40, start);
  const after = text.slice(end, end + 8);

  if (!digits) return null;
  if (letters && letters !== letters.toUpperCase() && letters !== letters.toLowerCase()) return null;

  let code = raw;
  if (!letters) {
    // Grouped digits are typed without the gaps: "557 260" is 557260.
    code = digits;
    if (raw.includes('-') && !/^\d{3,4}-\d{3,4}$/.test(raw)) return null; // dates, phone numbers
    if (digits.length < 4 || digits.length > 10) return null;
    // Part of a date, time, decimal or longer number: 12.12.2025, 10:49:27, 1.299,00
    if (/\d[.,:/-]$/.test(before) || /^[.,:/-]\d/.test(after)) return null;
    // Issue and ticket numbers, phone numbers, the next group of an IBAN
    if (/[#+]$/.test(before) || /(?:\d|\))[ /-]?$/.test(before) || /^[ /-]?\d/.test(after)) return null;
    // Amounts
    if (/[€$£]\s?$/.test(before) || /^\s?(?:[€$£%]|eur\b|usd\b|chf\b)/i.test(after)) return null;
  } else if (NUMBER_WITH_UNIT.test(raw) || PROMO_CODE.test(raw)) {
    return null;
  }
  if (LABELLED_AS_OTHER.test(before)) return null;
  if (PROMO_WORDS.test(contextWindow(text, start - 60, end + 40))) return null;

  let best = Infinity;
  let bestAfter = Infinity;
  for (const kw of keywords) {
    if (kw.start < end && kw.end > start) return null; // the candidate is part of a keyword ("2FA-Code")
    if (kw.end <= start && start - kw.end <= MAX_AFTER) {
      bestAfter = Math.min(bestAfter, start - kw.end);
      best = Math.min(best, start - kw.end);
    }
    if (kw.start >= end && kw.start - end <= MAX_BEFORE) best = Math.min(best, (kw.start - end) * 1.5);
  }
  if (best === Infinity) return null;

  // Lowercase letters also make up words, hashes and ids, so they have to
  // follow their keyword closely ("confirmation code is 5aem5f5z"), and a
  // lowercase hex string (a commit, a colour, a token) only counts when the
  // keyword labels it directly ("den Code e382e507-1593-47f8").
  if (letters && letters === letters.toLowerCase()) {
    if (bestAfter > 40) return null;
    if (LOWERCASE_HEX.test(raw) && bestAfter > 2) return null;
  }

  const linked = LINKED_BY.test(before);
  const ownLine = /(?:^|\n)\s*$/.test(before) && /^\s*(?:\n|$)/.test(after);
  // "KI Palooza 2026": a year is only the code when it is presented as one.
  if (!letters && YEAR.test(digits) && !linked && !ownLine) return null;

  let score = best;
  if (linked) score -= 15;
  if (ownLine) score -= 15;
  return { start, end, code, score };
}

const WORD_CHAR = /[\p{L}\p{N}-]/u;
const TRAILING_ELLIPSIS = /(?:\.\.\.|…)\s*$/u;

// `/[\p{L}\p{N}-]*(?:\.\.\.|…)\s*$/u` removed from the text, without that
// pattern's quadratic backtracking on a long unbroken word.
function stripTrailingEllipsis(text: string): string {
  const ellipsis = TRAILING_ELLIPSIS.exec(text);
  if (!ellipsis) return text;
  let start = ellipsis.index;
  while (start > 0) {
    const low = text.charCodeAt(start - 1);
    const width = low >= 0xdc00 && low <= 0xdfff && start > 1 ? 2 : 1;
    if (!WORD_CHAR.test(text.slice(start - width, start))) break;
    start -= width;
  }
  return text.slice(0, start);
}

function normalize(text: string): string {
  const cleaned = text
    // Invisible spacers senders put between characters
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]|\u034f/g, '')
    // Links and addresses carry ids and tokens, never the code to type
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    // (a word holding an "@" with something after it; `/\S*@\S+/` on its own
    // backtracks quadratically over a long word without one)
    .replace(/\S+/g, (word) => {
      const at = word.indexOf('@');
      return at !== -1 && at < word.length - 1 ? ' ' : word;
    })
    // Keep line breaks (a code often stands on a line of its own) but not
    // the runs of blank lines and indentation between table cells.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n[\s]*/g, '\n')
    .trim();
  // A preview is cut off with "...", and the word it cut may be half a code.
  return stripTrailingEllipsis(cleaned).trim();
}

function bestCandidate(rawText: string): Candidate | null {
  const text = normalize(rawText);
  if (!text) return null;
  const keywords = findCodeWords(text);
  if (!keywords.length) return null;

  let best: Candidate | null = null;
  for (const re of [CANDIDATE, GLUED_DIGITS]) {
    for (const match of text.matchAll(re)) {
      if (re === GLUED_DIGITS && !gluedToWords(text, match.index!, match.index! + match[0].length)) continue;
      const candidate = scoreCandidate(text, match[0], match.index!, keywords);
      if (candidate && (!best || candidate.score < best.score)) best = candidate;
    }
  }
  return best;
}

/**
 * The one-time code in a mail, or null. `text` is the preview for a list
 * row and the body for the reader. A code in the subject wins, since
 * senders that put it there ("Your code is 177945") also tend to repeat
 * it next to unrelated numbers in the body.
 */
export function findVerificationCode(subject: string | null | undefined, text: string | null | undefined): string | null {
  return bestCandidate(subject ?? '')?.code ?? bestCandidate(text ?? '')?.code ?? null;
}

/** Only fresh codes are worth a chip in the list; they expire within minutes to a day. */
export const VERIFICATION_CODE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isFreshForVerificationCode(receivedAt: string | undefined, now = Date.now()): boolean {
  if (!receivedAt) return false;
  const age = now - new Date(receivedAt).getTime();
  // A little slack for a server clock ahead of this one.
  return age >= -5 * 60 * 1000 && age <= VERIFICATION_CODE_MAX_AGE_MS;
}

/**
 * The code for a list row, from the subject and preview the list already
 * has; older mail is skipped without looking.
 */
export function listVerificationCode(
  email: Pick<Email, 'subject' | 'preview' | 'receivedAt'>,
  now = Date.now(),
): string | null {
  if (!isFreshForVerificationCode(email.receivedAt, now)) return null;
  return findVerificationCode(email.subject, email.preview);
}

// A code sits near the top; a newsletter of megabytes need not be read whole.
const MAX_BODY_HTML = 200_000;
const MAX_BODY_TEXT = 50_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

// An entity that is unknown or names no character becomes a space: leaving
// "&#x110000;" as text would hand the detector a code-shaped "x110000".
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (_whole, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? ' ';
    const point = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    if (point === 0) return '';
    if (!(point <= 0x10ffff) || (point >= 0xd800 && point <= 0xdfff)) return ' ';
    return String.fromCodePoint(point);
  });
}

const SKIPPED_ELEMENTS = new Set(['style', 'script', 'title']);
const LINE_BREAK_TAGS = new Set(['br', 'p', 'div', 'tr', 'li']);
const SPACE_TAGS = new Set(['td', 'th']);

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// Native has no DOM; this is the minimum the detector needs. Line breaks
// matter (a code often stands on a line of its own), markup does not.
// One pass over the string with indexOf, so hostile markup (thousands of
// unclosed tags) costs time in proportion to its length, never more.
function htmlToPlainText(html: string): string {
  // ASCII-only lowercase: same length as `html`, so indexes line up.
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const parts: string[] = [];
  const addText = (raw: string) => {
    if (raw) parts.push(decodeEntities(raw.replace(/[ \t\r\n]+/g, ' ')));
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { addText(html.slice(i)); break; }
    addText(html.slice(i, lt));
    const next = html.charCodeAt(lt + 1);
    const closing = next === 47; // '/'
    if (!isLetter(closing ? html.charCodeAt(lt + 2) : next) && next !== 33) {
      parts.push('<'); // a lone "<" is text
      i = lt + 1;
      continue;
    }
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) break; // an unterminated tag swallows the rest
    i = gt + 1;
    let nameEnd = lt + (closing ? 2 : 1);
    while (nameEnd < gt && /[A-Za-z0-9]/.test(html[nameEnd])) nameEnd++;
    const name = lower.slice(lt + (closing ? 2 : 1), nameEnd);
    if (!closing && SKIPPED_ELEMENTS.has(name)) {
      const closeAt = lower.indexOf(`</${name}`, i);
      if (closeAt === -1) break; // never closed: the rest is its content
      const closeEnd = html.indexOf('>', closeAt);
      if (closeEnd === -1) break;
      i = closeEnd + 1;
      parts.push(' ');
    } else if (LINE_BREAK_TAGS.has(name)) {
      parts.push('\n');
    } else if (SPACE_TAGS.has(name)) {
      parts.push(' ');
    }
  }
  return parts.join('');
}

/** The text of a loaded mail as the reader shows it, for finding its code. */
export function verificationCodeBodyText(
  email: Pick<Email, 'htmlBody' | 'textBody' | 'bodyValues' | 'preview'>,
): string {
  const picked = pickEmailBody(email);
  const html = selectRenderableHtml(picked);
  if (html) return htmlToPlainText(html.slice(0, MAX_BODY_HTML)).slice(0, MAX_BODY_TEXT);
  return (picked.text ?? '').slice(0, MAX_BODY_TEXT);
}
