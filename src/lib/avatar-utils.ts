// Two avatar schemes, ported verbatim from the webmail:
//
//   1. Account avatar (account-utils.ts) - 12-color fixed palette, hashed from
//      the account's email. Used for the sidebar account block and account
//      switcher.
//
//   2. Email-row avatar (components/ui/avatar.tsx) - HSL hue from a hash of
//      name or email. Used for per-message avatars in the email list.
//
// Both variants also define `getInitials` with slightly different rules, so we
// export them separately to keep the match 1:1.

import type { ContactCard } from '../api/types';
import { getContactPhotoRef, type ContactPhotoRef } from './contact-utils';
import { parseColor, relativeLuminance } from './event-colors';

// --- Account avatar -------------------------------------------------------

const ACCOUNT_AVATAR_PALETTE = [
  '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#d97706',
  '#65a30d', '#16a34a', '#0d9488', '#0891b2', '#6366f1', '#9333ea',
];

export function generateAvatarColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0;
  }
  return ACCOUNT_AVATAR_PALETTE[Math.abs(hash) % ACCOUNT_AVATAR_PALETTE.length];
}

/**
 * Account avatars. The webmail draws them with the same `Avatar` as senders,
 * so they get the same initials.
 */
export function getAccountInitials(name: string, email?: string): string {
  return getEmailInitials(name, email);
}

// --- Email-row avatar -----------------------------------------------------

// A display name that is only an address, as many headers and contacts have.
function isAddress(value: string): boolean {
  const v = value.trim();
  return v.includes('@') && !/\s/.test(v);
}

/**
 * The background behind the initials: picked from the address, so a person
 * has one colour whether or not a place knows their name, and the same one
 * the account switcher gives a signed-in account. Only without an address
 * does the name pick it (webmail components/ui/avatar.tsx avatarColor,
 * e2b383bd2, #1581).
 */
export function generateEmailAvatarColor(name: string, email?: string): string {
  const key = email?.trim().toLowerCase() || (name && isAddress(name) ? name.trim().toLowerCase() : name?.trim()) || '';
  return generateAvatarColor(key);
}

// An unspaced Han-character name is usually surname + given name. Compound
// surnames take two characters, so the given name of 司马光 starts at the
// third character, not the second.
const HAN_CHAR = /\p{Script=Han}/u;
const COMPOUND_SURNAMES = new Set([
  '欧阳', '司马', '上官', '诸葛', '东方', '独孤', '南宫', '万俟', '闻人',
  '夏侯', '令狐', '尉迟', '公孙', '长孙', '慕容', '司徒', '司空', '皇甫',
  '宇文', '呼延', '端木', '申屠', '公冶', '太叔', '西门', '鲜于', '闾丘',
  '轩辕', '百里', '拓跋', '澹台', '谷梁',
]);

/**
 * The given-name initials of an all-Han name, which is written without
 * spaces: 王阳明 → 阳明, 陈阳 → 陈阳, 司马光 → 光. Two characters are the
 * whole name, three are surname + given name, four only with a known
 * compound surname; anything longer, mixed, Latin or kana keeps the Western
 * rule (webmail hanGivenName, dde5bbf5a). Hangul is not Han script.
 */
function hanGivenName(name: string): string | null {
  const compact = name.replace(/\s+/g, '');
  if (compact.length < 2) return null;
  for (const ch of compact) {
    if (!HAN_CHAR.test(ch)) return null;
  }
  if (compact.length === 2) return compact;
  const compound = COMPOUND_SURNAMES.has(compact.slice(0, 2));
  if (compact.length === 3) return compound ? compact.slice(2, 3) : compact.slice(1, 3);
  if (compact.length === 4 && compound) return compact.slice(2, 4);
  return null;
}

/** `hsl(h, s%, l%)` as RGB; null for anything else. */
function hslToRgb(color: string): { r: number; g: number; b: number; a: number } | null {
  const m = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/i.exec(color.trim());
  if (!m) return null;
  const h = (Number(m[1]) % 360) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    a: 1,
  };
}

/**
 * White or black initials, whichever contrasts more with the background.
 * One of the two always reaches 4.58:1, so the initials pass 4.5:1 on every
 * generated colour; white alone failed on yellows, greens and cyans
 * (webmail components/ui/avatar.tsx initialsColor, 2e13accad).
 */
export function initialsColor(background: string): string {
  const rgb = hslToRgb(background) ?? parseColor(background);
  if (!rgb) return '#ffffff';
  const l = relativeLuminance(rgb);
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#000000';
}

/**
 * The letters shown when an avatar has no picture, as the webmail's
 * avatarInitials (components/ui/avatar.tsx, #1581): every avatar takes them
 * from here, so one person gets the same letters everywhere. A name gives
 * its first and last word's first letters (punctuation in front of a word
 * skipped: `"Sofia" Russo` is SR), or the first two letters of a single
 * word; an all-Han name its given name. Without a real name, the part of the
 * address before the @ is read as one, split at dots, dashes, underscores
 * and plus signs: "max.mustermann@" gives "MM", "xaver@" gives "XA".
 */
export function getEmailInitials(name: string, email?: string): string {
  const realName = name && !isAddress(name) ? name.trim() : '';
  const address = email?.trim() || (name && isAddress(name) ? name.trim() : '');
  const source = realName || (address.split('@')[0] ?? '').split(/[._+-]+/).filter(Boolean).join(' ');
  if (!source) return '?';
  const han = hanGivenName(source);
  if (han) return han;
  const parts = source
    .split(/\s+/)
    .map((p) => p.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter((p) => p.length > 0);
  if (parts.length >= 2) {
    return `${Array.from(parts[0])[0]}${Array.from(parts[parts.length - 1])[0]}`.toUpperCase();
  }
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join('').toUpperCase();
  return Array.from(source).slice(0, 2).join('').toUpperCase();
}

// --- Favicon lookup -------------------------------------------------------
//
// Ported from webmail `components/ui/avatar.tsx`: pick a registrable ("root")
// domain from the sender's email, skip personal mail providers, and fetch the
// logo from DuckDuckGo. The webmail goes through `/api/favicon?domain=...` as
// a caching proxy; native has no CORS constraint, so we hit DuckDuckGo direct.

// Multi-part TLDs (trimmed to the webmail client-side list - not the giant
// server PSL). Covers the common cases so subdomains resolve to the right
// registrable domain (e.g. newsletter.example.co.uk → example.co.uk).
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'net.uk',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'go.kr', 'ac.kr',
  'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz',
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'com.br', 'net.br', 'org.br', 'edu.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.mx', 'net.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
  'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  'com.my', 'net.my', 'org.my', 'edu.my', 'gov.my',
  'com.ph', 'net.ph', 'org.ph', 'edu.ph', 'gov.ph',
  'com.pk', 'net.pk', 'org.pk', 'edu.pk', 'gov.pk',
  'com.ng', 'net.ng', 'org.ng', 'edu.ng', 'gov.ng',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'co.th', 'or.th', 'ac.th', 'go.th', 'in.th',
  'co.id', 'or.id', 'ac.id', 'go.id', 'web.id',
  'com.tr', 'net.tr', 'org.tr', 'edu.tr', 'gov.tr',
  'com.ua', 'net.ua', 'org.ua', 'edu.ua', 'gov.ua',
  'com.eg', 'net.eg', 'org.eg', 'edu.eg', 'gov.eg',
  'com.sa', 'net.sa', 'org.sa', 'edu.sa', 'gov.sa',
  'co.ke', 'or.ke', 'ac.ke', 'go.ke', 'ne.ke',
]);

// Personal mail providers - the favicon here is the mail provider's logo, not
// anything specific to the sender, so we skip it.
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'yahoo.fr', 'yahoo.co.uk', 'yahoo.co.jp',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'mail.com',
  'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.com',
  'zoho.com', 'yandex.com', 'yandex.ru', 'gmx.com', 'gmx.net',
  'fastmail.com', 'hey.com', 'posteo.de', 'mailbox.org',
  'example.com', 'example.org',
]);

export function getRootDomain(domain: string): string {
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo)) {
    return parts.length >= 3 ? parts.slice(-3).join('.') : domain;
  }
  return parts.slice(-2).join('.');
}

// Returns the registrable domain to use for a favicon lookup, or null if the
// email address is missing or points at a personal mail provider.
export function getFaviconDomain(email: string | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain) return null;
  const root = getRootDomain(domain);
  if (PERSONAL_DOMAINS.has(root)) return null;
  return root;
}

export function getFaviconUrl(domain: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

// Module-level cache of domains whose favicons failed to load. Shared across
// all Avatar instances so we don't re-request known-bad domains in a session.
const failedFaviconDomains = new Set<string>();

export function hasFaviconFailed(domain: string): boolean {
  return failedFaviconDomains.has(domain);
}

export function markFaviconFailed(domain: string): void {
  failedFaviconDomains.add(domain);
}

// --- Contact photos -------------------------------------------------------
//
// Webmail `components/ui/avatar.tsx` looks the sender up in the address book
// and shows their contact photo ahead of favicons and initials. The mail list
// renders dozens of avatars, so build one lowercased email → photo index per
// contacts array and reuse it until the store hands out a new array. A photo
// is a URI (0.16) or a blob to download (Stalwart 1.0).

const contactPhotoIndexCache = new WeakMap<readonly ContactCard[], Map<string, ContactPhotoRef>>();

export function getContactPhotoIndex(contacts: readonly ContactCard[]): Map<string, ContactPhotoRef> {
  let index = contactPhotoIndexCache.get(contacts);
  if (index) return index;
  index = new Map();
  for (const contact of contacts) {
    if (!contact.emails) continue;
    const photo = getContactPhotoRef(contact);
    if (!photo) continue;
    for (const entry of Object.values(contact.emails)) {
      const key = entry?.address?.trim().toLowerCase();
      // First card with a photo wins, so the pick is stable across renders.
      if (key && !index.has(key)) index.set(key, photo);
    }
  }
  contactPhotoIndexCache.set(contacts, index);
  return index;
}

export function getContactPhotoForEmail(
  contacts: readonly ContactCard[],
  email: string | null | undefined,
): ContactPhotoRef | undefined {
  const key = email?.trim().toLowerCase();
  return key ? getContactPhotoIndex(contacts).get(key) : undefined;
}

// --- What the avatar shows --------------------------------------------------

export type AvatarContent = 'warning' | 'photo' | 'brand' | 'favicon' | 'initials';

/**
 * What a sender avatar shows, in the webmail `Avatar`'s order. A failed or
 * unverified sender check comes first: a warning shield instead of any photo,
 * logo, favicon or initials, so a forged From doesn't get the real sender's
 * logo or contact photo (webmail 605a3983b, #1439). Then the contact photo,
 * the domain's BIMI logo (see avatar-bimi.ts), the favicon.
 */
export function avatarContent(options: {
  senderWarning?: string | null;
  hasPhoto: boolean;
  showBrand?: boolean;
  showFavicon: boolean;
}): AvatarContent {
  if (options.senderWarning) return 'warning';
  if (options.hasPhoto) return 'photo';
  if (options.showBrand) return 'brand';
  if (options.showFavicon) return 'favicon';
  return 'initials';
}
