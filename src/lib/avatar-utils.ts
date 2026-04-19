// Two avatar schemes, ported verbatim from the webmail:
//
//   1. Account avatar (account-utils.ts) — 12-color fixed palette, hashed from
//      the account's email. Used for the sidebar account block and account
//      switcher.
//
//   2. Email-row avatar (components/ui/avatar.tsx) — HSL hue from a hash of
//      name or email. Used for per-message avatars in the email list.
//
// Both variants also define `getInitials` with slightly different rules, so we
// export them separately to keep the match 1:1.

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

export function getAccountInitials(name: string, email?: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0][0]?.toUpperCase() ?? '?';
  }
  if (email) return email[0]?.toUpperCase() ?? '?';
  return '?';
}

// --- Email-row avatar -----------------------------------------------------

export function generateEmailAvatarColor(name: string, email?: string): string {
  const str = name || email || '';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 50%)`;
}

export function getEmailInitials(name: string, email?: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  if (email) return email[0]?.toUpperCase() ?? '?';
  return '?';
}

// --- Favicon lookup -------------------------------------------------------
//
// Ported from webmail `components/ui/avatar.tsx`: pick a registrable ("root")
// domain from the sender's email, skip personal mail providers, and fetch the
// logo from DuckDuckGo. The webmail goes through `/api/favicon?domain=...` as
// a caching proxy; native has no CORS constraint, so we hit DuckDuckGo direct.

// Multi-part TLDs (trimmed to the webmail client-side list — not the giant
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

// Personal mail providers — the favicon here is the mail provider's logo, not
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
