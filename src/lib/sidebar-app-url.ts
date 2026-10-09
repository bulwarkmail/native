// Kept apart from sidebar-apps (which imports the settings store) so the
// store can check imported apps without an import cycle.

const MAX_APP_URL_LENGTH = 2048;

// Any space, C0/C1 control or Unicode separator/format character. A value
// holding one is rejected rather than trimmed, so what was validated is
// byte-for-byte what is stored and opened.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS_RE = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff]/;

const HTTPS_PREFIX_RE = /^https:\/\/[^\s\\/?#@]+/i;

/**
 * The one gate for a sidebar app URL, used on save, on listing and on open.
 * Only `https:` with a host and no backslash and no embedded credentials passes; the setting
 * has never allowed `http:`, so neither does this. Returns the normalized URL,
 * or null.
 */
export function sanitizeSidebarAppUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!raw || raw.length > MAX_APP_URL_LENGTH) return null;
  if (UNSAFE_CHARS_RE.test(raw)) return null;
  // Judged on the string alone so Node's WHATWG URL and React Native's regex
  // URL polyfill cannot disagree: a backslash is a slash to one and not the
  // other (`https:/\evil.com`, `https://a.com\@b.com`).
  if (raw.includes('\\')) return null;
  if (!HTTPS_PREFIX_RE.test(raw)) return null;
  const rest = raw.slice('https://'.length);
  const authority = rest.split(/[/?#]/, 1)[0];
  if (authority.includes('@')) return null;
  try {
    new URL(raw);
  } catch {
    return null;
  }
  return `https://${rest}`;
}
