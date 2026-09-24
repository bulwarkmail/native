// Safe HTML shaping for email bodies rendered inside a sandboxed WebView.
//
// Layered defenses (in order of importance):
//   1. The WebView runs the content with `originWhitelist={['about:blank']}`
//      and a strict Content-Security-Policy meta (default-src 'none'), so
//      external resources are blocked by the engine itself unless the policy
//      allows them. This is the primary boundary.
//   2. `onShouldStartLoadWithRequest` refuses any navigation except the
//      initial about:blank doc - links are opened in the OS browser / composer.
//   3. This module pre-strips known-dangerous tags and on* attributes so the
//      rendered DOM is also clean. Regex stripping is imperfect; it is here
//      as belt-and-suspenders, not the primary defense. `script-src
//      'unsafe-inline'` has to stay on for the injected measurement bridge,
//      so a parser-differential bypass of the regex stripper would execute in
//      the WebView. The blast radius is small: the page has no origin, no
//      storage, no cookies, and the bridge only accepts height/swipe/zoom
//      strings - but it is the residual risk of not using a real HTML parser.
//
// Tag/attribute lists mirror `lib/email-sanitization.ts` from the webmail.
// `<style>` is kept on purpose: the WebView is an isolated document, so the
// email's own stylesheet can't leak into the app, and stripping it destroyed
// class-based colours (native #46/#49). When external content is blocked the
// sheet is scrubbed of url()/@import/@font-face references instead.

const FORBIDDEN_TAGS = [
  'script', 'iframe', 'object', 'embed', 'form',
  'input', 'button', 'textarea', 'select', 'option',
  'meta', 'link', 'base', 'svg', 'math',
  'frame', 'frameset', 'applet', 'portal',
  // Mutation-XSS / parser-quirk vectors. `noscript` flips parsing modes when
  // JS is enabled, `xmp`/`plaintext`/`listing` switch the parser into raw-text
  // mode and can stash code that re-emerges after later transforms. Drop them
  // wholesale rather than try to reason about their interaction with the
  // strip pipeline below.
  'noscript', 'noembed', 'noframes', 'xmp', 'plaintext', 'listing',
  'template', 'slot', 'shadow',
];

// HTML comments can hide otherwise-stripped tags and survive certain DOM
// transforms (especially conditional comments, which old IE parsed as code).
// Strip comments too so nothing rides along inside them.
function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

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

/**
 * 1x1 transparent GIF used to replace a blocked external <img> so the layout
 * doesn't reflow to a broken-image icon. The real URL is stashed in
 * `data-blocked-src`.
 */
export const TRANSPARENT_BLOCKED_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Raster image types that stay allowed as a data: URI (mirrors the webmail allowlist). */
const RASTER_IMAGE_DATA_URI =
  /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif|x-icon|vnd\.microsoft\.icon)[;,]/i;

// Matches one start tag, keeping quoted attribute values (which may contain
// `>`) intact. Group 1 = tag name, group 2 = raw attribute text.
const TAG_RE = /<([a-z][a-z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
// One attribute inside a tag's attribute text.
const ATTR_RE = /([^\s=/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

interface ParsedAttr {
  name: string;
  /** Unquoted value, or null for a boolean attribute. */
  value: string | null;
}

function parseAttrs(raw: string): ParsedAttr[] {
  const out: ParsedAttr[] = [];
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    if (!m[1]) continue;
    const rawValue = m[2];
    if (rawValue === undefined) {
      out.push({ name: m[1], value: null });
    } else {
      const q = rawValue[0];
      const unquoted = (q === '"' || q === "'") ? rawValue.slice(1, -1) : rawValue;
      out.push({ name: m[1], value: unquoted });
    }
  }
  return out;
}

function serializeAttrs(attrs: ParsedAttr[]): string {
  return attrs
    .map((a) => (a.value === null ? a.name : `${a.name}="${a.value.replace(/"/g, '&quot;')}"`))
    .join(' ');
}

/** Rebuild every start tag through `fn`, which may edit its attribute list. */
function mapTags(
  html: string,
  fn: (tag: string, attrs: ParsedAttr[]) => ParsedAttr[] | null,
): string {
  return html.replace(TAG_RE, (full, tag: string, rawAttrs: string) => {
    const attrs = parseAttrs(rawAttrs);
    const next = fn(tag.toLowerCase(), attrs);
    if (next === null) return full;
    const selfClosing = /\/\s*$/.test(rawAttrs);
    const body = serializeAttrs(next);
    return `<${tag}${body ? ' ' + body : ''}${selfClosing ? ' /' : ''}>`;
  });
}

export function stripDangerousTags(html: string): string {
  // Strip comments first so they can't hide forbidden tags from the loops below.
  let out = stripHtmlComments(html);

  // Remove entire forbidden tag blocks (paired). Non-greedy across lines.
  // Loop-until-stable so nested forbidden tags collapse fully.
  let prev: string;
  do {
    prev = out;
    for (const tag of FORBIDDEN_TAGS) {
      const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
      out = out.replace(paired, '');
      const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
      out = out.replace(selfClosing, '');
      const closing = new RegExp(`<\\/${tag}\\s*>`, 'gi');
      out = out.replace(closing, '');
    }
  } while (out !== prev);

  // Strip inline event handlers - both `on*` and the rarer `formmethod`,
  // `srcdoc`, `ping` attribute families that have a side-channel.
  const dangerousAttrs = '(?:on[a-z]+|srcdoc|ping|formmethod|formenctype|formtarget|form)';
  out = out.replace(new RegExp(`\\s+${dangerousAttrs}\\s*=\\s*"[^"]*"`, 'gi'), '');
  out = out.replace(new RegExp(`\\s+${dangerousAttrs}\\s*=\\s*'[^']*'`, 'gi'), '');
  out = out.replace(new RegExp(`\\s+${dangerousAttrs}\\s*=\\s*[^\\s>]+`, 'gi'), '');

  // Neutralize dangerous URI schemes. Allow raster `data:image/*` and `cid:`.
  out = out.replace(
    /(\b(?:href|src|action|xlink:href|formaction|poster|background)\s*=\s*)(")([^"]*)(")/gi,
    (_m, pre, q1, value, q2) => `${pre}${q1}${safeUri(value)}${q2}`,
  );
  out = out.replace(
    /(\b(?:href|src|action|xlink:href|formaction|poster|background)\s*=\s*)(')([^']*)(')/gi,
    (_m, pre, q1, value, q2) => `${pre}${q1}${safeUri(value)}${q2}`,
  );

  // srcset is a list: check every candidate's scheme individually so an
  // allowed first candidate can't wave a `data:image/svg+xml` through.
  out = out.replace(
    /(\bsrcset\s*=\s*)(["'])([^"']*)\2/gi,
    (_m, pre, q, value: string) => `${pre}${q}${safeSrcset(value)}${q}`,
  );

  return out;
}

function decodeUriEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&(?:amp|colon|tab|newline);/gi, (m) =>
      m.toLowerCase() === '&amp;' ? '&' : m.toLowerCase() === '&colon;' ? ':' : '',
    )
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0020]+/g, '');
}

function safeUri(raw: string): string {
  // Decode HTML entities and strip control chars before scheme matching:
  // `&#x6A;avascript:` and `java\nscript:` are the two classic bypass shapes
  // that survive a naive prefix check.
  const trimmed = decodeUriEntities(raw).toLowerCase();
  // Block every non-allowlisted scheme rather than denylist-known-bad. Any
  // scheme followed by a colon that isn't on the allow list goes to #blocked.
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    const allowed = new Set(['http', 'https', 'mailto', 'tel', 'sms', 'cid']);
    if (allowed.has(scheme)) return raw;
    if (scheme === 'data') {
      // Only raster data:image/* is safe to inline. SVG is excluded because
      // the regex sanitizer cannot inspect bytes inside a data: URI, so an SVG
      // payload can carry <script>/<foreignObject> it never sees.
      return RASTER_IMAGE_DATA_URI.test(trimmed) ? raw : '#blocked';
    }
    return '#blocked';
  }
  // No scheme: relative URL, fragment, or plain text. Safe to keep as-is.
  return raw;
}

/**
 * srcset candidates are comma-separated `url [descriptor]` pairs, but a data:
 * URI itself contains commas, so the value can't be split reliably. Check
 * every `data:` occurrence where it stands and drop the whole attribute when
 * one is not an allowed raster image; otherwise keep only http(s)/cid/data
 * candidates.
 */
function safeSrcset(value: string): string {
  const dataUris = value.match(/data:[^,\s]*,?/gi);
  if (dataUris && dataUris.some((uri) => !RASTER_IMAGE_DATA_URI.test(uri))) return '';
  if (/data:/i.test(value)) return value;
  const candidates = value.split(',').map((c) => c.trim()).filter(Boolean);
  const kept = candidates.filter((cand) => {
    const url = decodeUriEntities(cand.split(/\s+/)[0] ?? '').toLowerCase();
    const scheme = url.match(/^([a-z][a-z0-9+.-]*):/)?.[1];
    return !scheme || scheme === 'http' || scheme === 'https' || scheme === 'cid';
  });
  return kept.join(', ');
}

export function plainTextToSafeHtml(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    (url) => `<a href="${url}" rel="noopener noreferrer">${url}</a>`,
  );
}

// ─── External-resource detection / blocking ──────────────────────────────

/**
 * True if a resource URL would trigger an external (network) fetch once the
 * engine normalizes it. The URL parser removes ASCII tab/newline characters
 * anywhere in the string and trims leading/trailing C0-control + space before
 * resolving, so `"\n\nhttps://t"` and `"h\ttps://t"` are both external even
 * though they don't literally start with "https://". Protocol-relative
 * `//host` is external too. data:, blob:, and cid: never count as external.
 */
export function isExternalResourceUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  // eslint-disable-next-line no-control-regex
  const normalized = value.replace(/[\u0000-\u0020]+/g, '');
  return /^(?:https?:\/\/|\/\/)/i.test(normalized);
}

/**
 * Decode CSS escape sequences so escaped tracking URLs can be recognised.
 * `\68ttp://x` and `\000068ttp://x` both decode to `http://x`. Handles the two
 * CSS escape forms: 1-6 hex digits (optionally followed by one whitespace)
 * and a backslash before any other character.
 */
export function decodeCssEscapes(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_full, hex, char) => {
    if (hex) {
      const code = parseInt(hex, 16);
      return code ? String.fromCodePoint(code) : '';
    }
    return char ?? '';
  });
}

const CSS_URL_PATTERN = /url\(\s*(['"]?)([^)]*?)\1\s*\)/gi;

/** True if any `url(...)` in a CSS string resolves to an external resource. */
export function styleHasExternalUrl(style: string): boolean {
  let found = false;
  style.replace(CSS_URL_PATTERN, (full, _q, inner) => {
    if (isExternalResourceUrl(decodeCssEscapes(inner))) found = true;
    return full;
  });
  return found;
}

/** Replace every external `url(...)` in a CSS string with an empty `url()`. */
export function stripExternalCssUrls(style: string): string {
  return style.replace(CSS_URL_PATTERN, (full, _q, inner) =>
    isExternalResourceUrl(decodeCssEscapes(inner)) ? 'url()' : full,
  );
}

/**
 * Neutralise external references in a full stylesheet (a kept `<style>`
 * block): background `url()`, `@font-face` sources and `@import`. Escapes are
 * decoded on the WHOLE block first because the "css escape" tracker escapes
 * the `url` keyword itself (`\75\72\6C(` -> `url(`). Returns the original
 * (escapes intact) when nothing external is present, so callers can detect a
 * change by identity. (#457)
 */
export function stripExternalStyleSheetCss(css: string): string {
  if (!css) return css;
  const decoded = decodeCssEscapes(css);
  if (!/url\(|@import/i.test(decoded)) return css;
  let changed = false;
  let result = decoded.replace(CSS_URL_PATTERN, (full, _q, inner: string) => {
    if (isExternalResourceUrl(inner)) {
      changed = true;
      return 'url()';
    }
    return full;
  });
  result = result.replace(
    /@import\s+(['"])\s*(?:https?:)?\/\/[^'"]*\1[^;]*;?/gi,
    () => {
      changed = true;
      return '';
    },
  );
  return changed ? result : css;
}

function srcsetHasExternalUrl(srcset: string): boolean {
  return srcset
    .split(',')
    .some((candidate) => isExternalResourceUrl(candidate.trim().split(/\s+/)[0]));
}

function appendStyle(attrs: ParsedAttr[], extra: string): void {
  const style = attrs.find((a) => a.name.toLowerCase() === 'style');
  if (style) {
    style.value = `${style.value ?? ''};${extra}`;
  } else {
    attrs.push({ name: 'style', value: extra });
  }
}

export interface BlockExternalResult {
  html: string;
  /** True when at least one external resource was actually neutralised. */
  blocked: boolean;
}

/**
 * Neutralise every external-resource vector, stashing the original value in
 * a `data-blocked-*` attribute. Covers the vectors beyond a bare `<img src>`:
 * whitespace/newline in src, `<picture><source srcset>`, `<video poster>` /
 * media src, the legacy `background` attribute, inline `style` url()
 * (including CSS-escaped URLs) and `<style>` block CSS. The strict CSP the
 * caller derives from the policy is the guaranteed network-level backstop;
 * this pass drives the banner and the placeholder swap.
 */
export function blockExternalResources(html: string): BlockExternalResult {
  let blocked = false;

  let out = mapTags(html, (tag, attrs) => {
    let changed = false;
    const get = (name: string) => attrs.find((a) => a.name.toLowerCase() === name);
    const remove = (name: string) => {
      const i = attrs.findIndex((a) => a.name.toLowerCase() === name);
      if (i >= 0) attrs.splice(i, 1);
    };

    if (tag === 'img') {
      const src = get('src');
      if (src?.value && isExternalResourceUrl(src.value)) {
        attrs.push({ name: 'data-blocked-src', value: src.value.trim() });
        src.value = TRANSPARENT_BLOCKED_PIXEL;
        const alt = get('alt');
        if (alt) alt.value = ''; else attrs.push({ name: 'alt', value: '' });
        appendStyle(attrs, 'display:none');
        changed = true;
      }
    }

    if (tag === 'img' || tag === 'source') {
      const srcset = get('srcset');
      if (srcset?.value && srcsetHasExternalUrl(srcset.value)) {
        attrs.push({ name: 'data-blocked-srcset', value: srcset.value });
        remove('srcset');
        changed = true;
      }
    }

    if (tag === 'source' || tag === 'video' || tag === 'audio') {
      const src = get('src');
      if (src?.value && isExternalResourceUrl(src.value)) {
        attrs.push({ name: 'data-blocked-src', value: src.value.trim() });
        remove('src');
        changed = true;
      }
    }

    if (tag === 'video' || tag === 'audio') {
      const poster = get('poster');
      if (poster?.value && isExternalResourceUrl(poster.value)) {
        attrs.push({ name: 'data-blocked-poster', value: poster.value.trim() });
        remove('poster');
        changed = true;
      }
    }

    const bg = get('background');
    if (bg?.value && isExternalResourceUrl(bg.value)) {
      attrs.push({ name: 'data-blocked-background', value: bg.value.trim() });
      remove('background');
      changed = true;
    }

    const style = get('style');
    if (style?.value && styleHasExternalUrl(style.value)) {
      attrs.push({ name: 'data-blocked-style', value: style.value });
      style.value = stripExternalCssUrls(style.value);
      changed = true;
    }

    if (changed) blocked = true;
    return changed ? attrs : null;
  });

  // <style> block CSS.
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_m, open, css: string, close) => {
    const cleaned = stripExternalStyleSheetCss(css);
    if (cleaned !== css) blocked = true;
    return `${open}${cleaned}${close}`;
  });

  return { html: out, blocked };
}

/** True when the HTML references at least one external (network) resource. */
export function hasRemoteContent(html: string): boolean {
  return blockExternalResources(html).blocked;
}

// ─── Styles ──────────────────────────────────────────────────────────────

// Base styles for HTML emails - mirrors the webmail iframe body.
// Emails are authored for light mode; we render them true-to-life and apply a
// filter inversion trick for dark mode (unless the email has native dark
// support via @media (prefers-color-scheme: dark)).
function baseStyles(bodyPadding: string): string {
  return `
html { background: #ffffff; height: auto !important; }
/* The injected reporter lays wide content out at its natural width and scales
   it down to fit; overflow-x: hidden kills any residual sideways scrolling. */
html, body { overflow-x: hidden; }
/* Some emails put height:100% on a full-bleed wrapper, which with our
   auto-height measurement clips the content to a sliver. Neutralise it. */
[style*="height:100%"], [style*="height: 100%"] { height: auto !important; }
body {
  margin: 0;
  padding: ${bodyPadding};
  height: auto !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color: #1a1a1a;
  background: #ffffff;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
/* Only force the cap on images and tables that set no max-width of their own:
   an !important 100% also overrides a sender's inline max-width, so an image
   sized by max-width + max-height + width:100% grows to the pane width while
   its max-height still clamps the height (squashed), and a table with
   max-width:300px spans the pane. Content wider than the pane is still
   scaled to fit by the injected reporter. height stays !important so a fixed
   inline height cannot squash an image. (#790) */
img:not([style*="max-width"]) { max-width: 100% !important; }
img[style*="max-width"] { max-width: 100%; }
img { height: auto !important; }
a { color: #1a73e8; }
table:not([style*="max-width"]) { max-width: 100% !important; }
table[style*="max-width"] { max-width: 100%; }
table { table-layout: auto; overflow-wrap: break-word; }
td, th { overflow-wrap: break-word; }
pre { white-space: pre-wrap; word-wrap: break-word; }
`;
}

// Word emails rely on empty <p class=MsoNormal>&nbsp;</p> spacers for vertical
// rhythm. With our default line-height: 1.6 these stack into oversized gaps;
// tighten to match how Outlook/Gmail render the same source.
const WORD_HTML_CSS = `
body { line-height: 1.15; }
p.MsoNormal, li.MsoNormal, div.MsoNormal { margin: 0 0 6px; }
`;

// Applied when the host is in dark mode and the email does NOT have native
// dark-mode CSS. Matches the webmail's darkModeCSS verbatim.
//
// Background-COLOR containers (bgcolor, background: shorthand) are re-inverted
// so their fill flips to a dark tone, but skipped when they wrap media: the
// inner image already gets its own re-invert, and a filter on the container
// would double-invert it. Nested colour containers must NOT stack another
// invert either - each filter toggles the inversion, so an odd number of
// stacked filters lands back on light-on-light; the descendant rule disables
// filter on a colour container nested inside another.
//
// Background-IMAGE containers are different: a real photo and whatever is
// composited over it was designed by the sender to read together, so the
// whole subtree should return to its original light-mode appearance - even
// when it wraps media. Re-invert those unconditionally (no :has guard) and
// cancel the per-image re-invert for media inside them.
const DARK_INVERSION = `
html { background: #121212; }
body { filter: invert(1) hue-rotate(180deg); background: #ededed; }
img, video, svg, canvas, object, embed, input[type="image"] {
  filter: invert(1) hue-rotate(180deg);
}
[style*="background:"]:not(:has(img, video, svg, canvas, object, embed)),
[bgcolor]:not(:has(img, video, svg, canvas, object, embed)) {
  filter: invert(1) hue-rotate(180deg);
}
:where([style*="background:"], [bgcolor])
  :where([style*="background:"], [bgcolor]):not(:has(img, video, svg, canvas, object, embed)) {
  filter: none !important;
}
[style*="background-image"],
[background] {
  filter: invert(1) hue-rotate(180deg);
}
[style*="background-image"] :where(img, video, svg, canvas, object, embed, input[type="image"]),
[background] :where(img, video, svg, canvas, object, embed, input[type="image"]) {
  filter: none;
}
`;

// Matches the webmail's `emailHasNativeDarkMode` detector: true if the HTML
// contains a `@media (prefers-color-scheme: dark)` rule.
export function hasNativeDarkMode(html: string): boolean {
  return /prefers-color-scheme\s*:\s*dark/i.test(html);
}

function isWordHtml(html: string): boolean {
  return /class=["']?(?:Mso|WordSection)|<o:p[\s>/]|urn:schemas-microsoft-com:office:office/i.test(html);
}

// "auto" spacing: only drop our gutter when the mail paints a full-bleed
// background canvas (a width:100% element carrying a background colour) - the
// one case where the gutter shows as a frame around the email's own
// background.
function hasFullBleedCanvas(html: string): boolean {
  return (
    /<(?:table|div|body)\b[^>]*(?:\bwidth\s*=\s*["']?\s*100%|width\s*:\s*100%)[^>]*(?:\bbgcolor\s*=|background(?:-color)?\s*:)/i.test(html) ||
    /<(?:table|div|body)\b[^>]*(?:\bbgcolor\s*=|background(?:-color)?\s*:)[^>]*(?:\bwidth\s*=\s*["']?\s*100%|width\s*:\s*100%)/i.test(html)
  );
}

// ─── cid: inline images ──────────────────────────────────────────────────

// Returns the set of cid references (without the `cid:` prefix or angle
// brackets) used by <img src="cid:...">, for callers that prefetch inline blobs.
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
    return cidMap[key] ?? TRANSPARENT_BLOCKED_PIXEL;
  });
}

// ─── Document assembly ───────────────────────────────────────────────────

export type MessageSpacing = 'auto' | 'always' | 'edge';

export interface WrapOptions {
  /** Neutralise external resources and switch to the strict CSP. */
  blockRemoteImages?: boolean;
  cidMap?: Record<string, string>;
  /** When true, the host renders in dark mode; inversion is applied unless
   *  the email already has native dark-mode CSS. */
  isDark?: boolean;
  messageSpacing?: MessageSpacing;
}

export interface PreparedEmailHtml {
  html: string;
  /** Inversion CSS is in effect; the DOM re-invert pass should run. */
  applyInversion: boolean;
  /** The email ships its own `prefers-color-scheme: dark` rules. */
  hasNativeDark: boolean;
  /** At least one external resource was neutralised. */
  blockedExternal: boolean;
}

function buildCsp(strict: boolean): string {
  // Strict CSP. Inline <script> and handlers from the email are stripped by
  // `stripDangerousTags`, so script-src only needs to allow our own injected
  // measurement bridge - 'unsafe-inline' is the minimum that lets RN WebView's
  // injected script run on Android (where page CSP can apply to evaluateJs).
  //
  // In blocking mode img/media/font are restricted to data: only - the
  // network-level backstop for every tracking vector, including ones the
  // attribute pass can't see.
  const resources = strict
    ? ['img-src data: cid:', 'font-src data:', "media-src 'none'"]
    : ['img-src data: cid: https: http:', 'font-src data: https: http:', 'media-src data: https: http:'];
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    ...resources,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Turn a raw HTML body into a complete, sandboxed document. `hasNativeDark`
 * and `applyInversion` are evaluated once on the sanitised input and returned
 * so the caller injects the matching DOM pass (a mismatch between the CSS
 * decision and the script decision was native #49).
 */
export function prepareEmailHtml(innerHtml: string, options: WrapOptions = {}): PreparedEmailHtml {
  const { blockRemoteImages = false, cidMap, isDark = true, messageSpacing = 'auto' } = options;
  const cleaned = stripDangerousTags(innerHtml);
  const withCids = cidMap ? replaceCidRefs(cleaned, cidMap) : cleaned;
  let processed = withCids;
  let blockedExternal = false;
  if (blockRemoteImages) {
    const res = blockExternalResources(withCids);
    processed = res.html;
    blockedExternal = res.blocked;
  }

  const hasNativeDark = hasNativeDarkMode(processed);
  const applyInversion = isDark && !hasNativeDark;
  const colorScheme = isDark && hasNativeDark ? 'light dark' : 'light';
  const darkCss = applyInversion ? DARK_INVERSION : '';

  const word = isWordHtml(processed);
  const hasStyleTag = /<style\b/i.test(processed);
  const autoDropsGutter = hasStyleTag && !word && hasFullBleedCanvas(processed);
  const dropGutter = messageSpacing === 'edge' || (messageSpacing === 'auto' && autoDropsGutter);
  const bodyPadding = dropGutter ? '0' : '16px';

  const html = `<!doctype html>
<html style="color-scheme: ${colorScheme};">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(blockRemoteImages)}">
<meta name="referrer" content="no-referrer">
<style>${baseStyles(bodyPadding)}${word ? WORD_HTML_CSS : ''}${darkCss}</style>
</head>
<body>${processed}<style>html,body{height:auto!important;min-height:0!important;max-height:none!important}</style></body>
</html>`;

  return { html, applyInversion, hasNativeDark, blockedExternal };
}

export function wrapEmailHtml(innerHtml: string, options: WrapOptions = {}): string {
  return prepareEmailHtml(innerHtml, options).html;
}

export type PlainTextFont = 'sans' | 'mono';

// Wrap a plain-text body (already run through `plainTextToSafeHtml`) for the
// WebView. Mirrors the webmail's plain-text render path: app font by default
// (monospace on request, #830), `white-space: pre-wrap`, native dark theme
// (no filter inversion), and a dark-mode-appropriate link colour.
export function wrapPlainTextEmail(
  innerHtml: string,
  options: { isDark?: boolean; font?: PlainTextFont } = {},
): string {
  const { isDark = true, font = 'sans' } = options;
  const cleaned = stripDangerousTags(innerHtml);

  const bg = isDark ? '#09090b' : '#ffffff';
  const fg = isDark ? '#fafafa' : '#1a1a1a';
  const link = isDark ? '#60a5fa' : '#1a73e8';
  const fontFamily = font === 'mono'
    ? 'ui-monospace, Menlo, Consolas, "SF Mono", monospace'
    : '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const styles = `
html, body { background: ${bg}; }
/* Pinch-zoomed content overflows sideways; it is panned via the injected
   transform, never via native horizontal scrolling. */
html, body { overflow-x: hidden; }
body {
  margin: 0;
  padding: 16px;
  font-family: ${fontFamily};
  font-size: 14px;
  line-height: 1.6;
  color: ${fg};
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
}
a { color: ${link}; text-decoration: underline; }
details > summary::-webkit-details-marker { display: none; }
`;

  return `<!doctype html>
<html style="color-scheme: ${isDark ? 'dark' : 'light'};">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(true)}">
<style>${styles}</style>
</head>
<body>${cleaned}</body>
</html>`;
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

// Inspect the first bytes of an inline image so the data: URI carries a MIME
// the engine will decode. Some clients label cid parts `application/octet-
// stream` (#543), which Chromium/WebKit refuse to render as an image.
export function sniffImageMime(bytes: Uint8Array, fallback?: string): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  const f = (fallback || '').toLowerCase().split(';')[0].trim();
  if (f.startsWith('image/')) return f;
  return 'application/octet-stream';
}
