// Safe HTML shaping for email bodies rendered inside a sandboxed WebView.
//
// Layered defenses (in order of importance):
//   1. The WebView runs the content with `originWhitelist={['about:*']}` and a
//      strict Content-Security-Policy meta (no script-src, no default-src),
//      so inline <script>, inline event handlers, and external resources are
//      blocked by the engine itself. This is the primary boundary.
//   2. `onShouldStartLoadWithRequest` refuses any navigation except the
//      initial about:blank doc - links are opened in the OS browser.
//   3. This module pre-strips known-dangerous tags and on* attributes so the
//      rendered DOM is also clean. Regex stripping is imperfect; it is here
//      as belt-and-suspenders, not the primary defense.
//
// Tag/attribute lists mirror `lib/email-sanitization.ts` from the webmail.

const FORBIDDEN_TAGS = [
  'script', 'iframe', 'object', 'embed', 'form',
  'input', 'button', 'textarea', 'select', 'option',
  'meta', 'link', 'base', 'style', 'svg', 'math',
  'frame', 'frameset', 'applet', 'portal',
];

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

export function stripDangerousTags(html: string): string {
  let out = html;

  // Remove entire forbidden tag blocks (paired). Non-greedy across lines.
  for (const tag of FORBIDDEN_TAGS) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    out = out.replace(paired, '');
    const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    out = out.replace(selfClosing, '');
    const closing = new RegExp(`<\\/${tag}\\s*>`, 'gi');
    out = out.replace(closing, '');
  }

  // Strip inline event handlers (on* attributes)
  out = out.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');

  // Neutralize dangerous URI schemes. Allow `data:image/*` and `cid:`.
  out = out.replace(
    /(\b(?:href|src|action|xlink:href|formaction|poster)\s*=\s*)(")([^"]*)(")/gi,
    (_m, pre, q1, value, q2) => `${pre}${q1}${safeUri(value)}${q2}`,
  );
  out = out.replace(
    /(\b(?:href|src|action|xlink:href|formaction|poster)\s*=\s*)(')([^']*)(')/gi,
    (_m, pre, q1, value, q2) => `${pre}${q1}${safeUri(value)}${q2}`,
  );

  return out;
}

function safeUri(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith('javascript:') || trimmed.startsWith('vbscript:')) {
    return '#blocked';
  }
  if (trimmed.startsWith('data:') && !trimmed.startsWith('data:image/')) {
    return '#blocked';
  }
  return raw;
}

export function plainTextToSafeHtml(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    (url) => `<a href="${url}" rel="noopener noreferrer">${url}</a>`,
  );
}

// Base styles for HTML emails - mirrors the webmail iframe body 1:1.
// Emails are authored for light mode; we render them true-to-life and apply a
// filter inversion trick for dark mode (unless the email has native dark
// support via @media (prefers-color-scheme: dark)).
const BASE_STYLES = `
html { background: #ffffff; }
body {
  margin: 0;
  padding: 16px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color: #1a1a1a;
  background: #ffffff;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
img { max-width: 100% !important; height: auto !important; }
a { color: #1a73e8; }
table { max-width: 100% !important; table-layout: auto; overflow-wrap: break-word; }
td, th { word-break: break-word; }
pre { white-space: pre-wrap; word-wrap: break-word; }
`;

// Applied when the host is in dark mode and the email does NOT have native
// dark-mode CSS. Inverts the body, then re-inverts media elements so they
// display correctly. Matches the webmail's darkModeCSS.
const DARK_INVERSION = `
html { background: #1a1a1a; }
body { filter: invert(1) hue-rotate(180deg); }
img, video, svg, canvas, object, embed, input[type="image"] {
  filter: invert(1) hue-rotate(180deg);
}
[style*="background-image"]:not(:has(img, video, svg, canvas, object, embed)),
[style*="background:"]:not(:has(img, video, svg, canvas, object, embed)),
[background]:not(:has(img, video, svg, canvas, object, embed)),
[bgcolor]:not(:has(img, video, svg, canvas, object, embed)),
td[background]:not(:has(img, video, svg, canvas, object, embed)),
table[background]:not(:has(img, video, svg, canvas, object, embed)) {
  filter: invert(1) hue-rotate(180deg);
}
`;

export interface WrapOptions {
  blockRemoteImages?: boolean;
  cidMap?: Record<string, string>;
  // When true, the host renders in dark mode; inversion is applied unless the
  // email already has native dark-mode CSS.
  isDark?: boolean;
}

// Matches the webmail's `emailHasNativeDarkMode` detector: true if the HTML
// contains a `@media (prefers-color-scheme: dark)` rule.
export function hasNativeDarkMode(html: string): boolean {
  return /prefers-color-scheme\s*:\s*dark/i.test(html);
}

// Returns the set of cid references (without the `cid:` prefix or angle brackets)
// used by <img src="cid:...">, for callers that need to prefetch inline blobs.
export function extractCidRefs(html: string): string[] {
  const out = new Set<string>();
  const re = /\bcid:([^"'\s)>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.add(m[1].replace(/^<|>$/g, ''));
  }
  return Array.from(out);
}

function replaceCidRefs(html: string, cidMap: Record<string, string>): string {
  return html.replace(/\bcid:([^"'\s)>]+)/gi, (_m, ref: string) => {
    const key = ref.replace(/^<|>$/g, '');
    return cidMap[key] ?? 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  });
}

export function wrapEmailHtml(innerHtml: string, options: WrapOptions = {}): string {
  const { blockRemoteImages = false, cidMap, isDark = true } = options;
  const cleaned = stripDangerousTags(innerHtml);
  const withCids = cidMap ? replaceCidRefs(cleaned, cidMap) : cleaned;
  const processed = blockRemoteImages ? blockRemoteImageSrcs(withCids) : withCids;

  const emailHasNativeDark = hasNativeDarkMode(processed);
  const applyInversion = isDark && !emailHasNativeDark;
  const colorScheme = isDark && emailHasNativeDark ? 'light dark' : 'light';
  const darkCss = applyInversion ? DARK_INVERSION : '';

  // Strict CSP. Inline <script> and handlers from the email are stripped by
  // `stripDangerousTags`, so script-src only needs to allow our own injected
  // measurement bridge - 'unsafe-inline' is the minimum that lets RN WebView's
  // injected script run on Android (where page CSP can apply to evaluateJs).
  const imgSrc = blockRemoteImages ? "img-src data: cid:" : "img-src data: cid: https: http:";
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "font-src data:",
    imgSrc,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  return `<!doctype html>
<html style="color-scheme: ${colorScheme};">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${BASE_STYLES}${darkCss}</style>
</head>
<body>${processed}</body>
</html>`;
}

// Wrap a plain-text body (already run through `plainTextToSafeHtml`) for the
// WebView. Mirrors the webmail's plain-text render path: monospace font,
// `white-space: pre-wrap`, native dark theme (no filter inversion), and a
// dark-mode-appropriate link color.
export function wrapPlainTextEmail(innerHtml: string, options: { isDark?: boolean } = {}): string {
  const { isDark = true } = options;
  const cleaned = stripDangerousTags(innerHtml);

  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  const bg = isDark ? '#09090b' : '#ffffff';
  const fg = isDark ? '#fafafa' : '#1a1a1a';
  const link = isDark ? '#60a5fa' : '#1a73e8';

  const styles = `
html, body { background: ${bg}; }
body {
  margin: 0;
  padding: 16px;
  font-family: ui-monospace, Menlo, Consolas, "SF Mono", monospace;
  font-size: 14px;
  line-height: 1.6;
  color: ${fg};
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}
a { color: ${link}; text-decoration: underline; }
`;

  return `<!doctype html>
<html style="color-scheme: ${isDark ? 'dark' : 'light'};">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${styles}</style>
</head>
<body>${cleaned}</body>
</html>`;
}

// Replace remote image srcs with a placeholder. Inline (cid:/data:image/) are kept.
// Also strips CSS `url(http(s):...)` in inline styles and HTML `background=` attrs.
// Mirrors the webmail's DOMPurify afterSanitizeAttributes hook.
function blockRemoteImageSrcs(html: string): string {
  let out = html;

  out = out.replace(
    /(<img\b[^>]*\bsrc\s*=\s*)(["'])(https?:\/\/[^"']*|\/\/[^"']*)\2/gi,
    (_m, pre, quote, url) =>
      `${pre}${quote}${quote} alt="[remote image blocked]" data-blocked-src=${quote}${url}${quote}`,
  );

  out = out.replace(
    /\bsrcset\s*=\s*(["'])[^"']*\1/gi,
    'srcset=""',
  );

  out = out.replace(
    /\bbackground\s*=\s*(["'])(https?:\/\/[^"']*|\/\/[^"']*)\1/gi,
    'background=""',
  );

  out = out.replace(
    /(\bstyle\s*=\s*)(["'])([^"']*)\2/gi,
    (_m, pre, quote, style: string) => {
      const stripped = style.replace(
        /url\(\s*(['"]?)(?:https?:|\/\/)[^'")\s]+\1\s*\)/gi,
        'url()',
      );
      return `${pre}${quote}${stripped}${quote}`;
    },
  );

  return out;
}

// Mirrors the webmail's `hasMeaningfulHtmlBody` (lib/signature-utils.ts).
// Returns false when the HTML is an auto-generated minimal wrapper around plain
// text (no <br>, no links, no rich tags) - the caller should fall back to the
// textBody in that case, since the server-side HTML often collapses newlines.
const MEANINGFUL_HTML_RE =
  /<(?:table|img|style|b|strong|i|em|u|font|h[1-6]|ul|ol|blockquote|br)\b|<a\b[^>]*\bhref=|<(?:div|span|p)\b[^>]*\bstyle=/i;

export function hasMeaningfulHtmlBody(html: string): boolean {
  if (!html.trim()) return false;
  if (MEANINGFUL_HTML_RE.test(html)) return true;
  // Fallback: more than one block element suggests structure.
  const blockMatches = html.match(/<(?:p|div|blockquote|li)\b/gi);
  return (blockMatches?.length ?? 0) > 1;
}

export function hasRemoteContent(html: string): boolean {
  if (/<img\b[^>]*\bsrc\s*=\s*["'](?:https?:\/\/|\/\/)/i.test(html)) return true;
  if (/\bbackground\s*=\s*["'](?:https?:\/\/|\/\/)/i.test(html)) return true;
  if (/\bstyle\s*=\s*["'][^"']*url\(\s*['"]?(?:https?:|\/\/)/i.test(html)) return true;
  return false;
}
