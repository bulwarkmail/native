import { describe, it, expect } from 'vitest';
import {
  stripDangerousTags,
  isExternalResourceUrl,
  decodeCssEscapes,
  stripExternalStyleSheetCss,
  blockExternalResources,
  hasRemoteContent,
  prepareEmailHtml,
  wrapPlainTextEmail,
  wrapEmailHtml,
  hasNativeDarkMode,
  sniffImageMime,
  TRANSPARENT_BLOCKED_PIXEL,
  isUserLinkNavigation,
} from '../email-html';

describe('stripDangerousTags', () => {
  it('keeps <style> blocks (the WebView is an isolated document)', () => {
    const out = stripDangerousTags('<style>.hero{color:#fff}</style><div class="hero">x</div>');
    expect(out).toContain('<style>.hero{color:#fff}</style>');
  });

  it('still removes scripts, iframes, svg, link and event handlers', () => {
    const out = stripDangerousTags(
      '<script>1</script><iframe src="x"></iframe><svg><script>2</script></svg>'
      + '<link rel="stylesheet" href="https://x/a.css"><a onclick="evil()" href="https://x">l</a>',
    );
    expect(out).not.toMatch(/<script|<iframe|<svg|<link|onclick/i);
    expect(out).toContain('href="https://x"');
  });

  it('allows only raster data: image URIs', () => {
    expect(stripDangerousTags('<img src="data:image/png;base64,AAAA">')).toContain('data:image/png');
    expect(stripDangerousTags('<img src="data:image/svg+xml;base64,AAAA">')).toContain('#blocked');
    expect(stripDangerousTags('<a href="data:text/html,<script>">x</a>')).toContain('#blocked');
  });

  it('scheme-checks every srcset candidate', () => {
    const out = stripDangerousTags('<img srcset="https://a/1.png 1x, javascript:alert(1) 2x">');
    expect(out).toContain('srcset="https://a/1.png 1x"');
    const svg = stripDangerousTags('<img srcset="data:image/png;base64,AA 1x, data:image/svg+xml;base64,AA 2x">');
    expect(svg).toContain('srcset=""');
  });

  it('blocks entity-obfuscated javascript: URLs', () => {
    expect(stripDangerousTags('<a href="&#x6A;avascript:alert(1)">x</a>')).toContain('#blocked');
    expect(stripDangerousTags('<a href="java\nscript:alert(1)">x</a>')).toContain('#blocked');
  });

  // GHSA-g35q-3gpc-x2rr: the browser starts a new attribute after a slash or
  // right after a closing quote, with no whitespace in between.
  it('drops on* handlers that follow a slash or a quote', () => {
    for (const input of [
      '<img src="x"/onerror=alert(1)>',
      '<img/onerror=alert(1) src=x>',
      '<img src="x"onerror="alert(1)">',
      "<img src='x'/onerror='alert(1)'>",
      '<body/onload=alert(1)>',
      '<img src=x ONERROR=alert(1)>',
    ]) {
      expect(stripDangerousTags(input), input).not.toMatch(/onerror|onload/i);
    }
  });

  it('reads an attribute after a slash as a new, URI-checked attribute', () => {
    expect(stripDangerousTags('<a title="x"/href="javascript:alert(1)">l</a>')).toContain('href="#blocked"');
  });

  it('leaves no tag hidden behind a stray quote in an attribute name', () => {
    expect(stripDangerousTags('<img x"=y onerror=alert(1) src=z>')).not.toMatch(/onerror/i);
  });

  it('does not read tags inside a stylesheet, where the browser sees text', () => {
    const out = stripDangerousTags('<style>/*<a b="*/</style><img src=x onerror=alert(1) c="">');
    expect(out).toContain('<style>/*<a b="*/</style>');
    expect(out).not.toMatch(/onerror/i);
  });

  it('ends comments where the browser does', () => {
    expect(stripDangerousTags('a<!-- x --!><img src=x onerror=alert(1)>')).not.toMatch(/onerror/i);
    expect(stripDangerousTags('<p>a</p><!--> <img src=x onerror=alert(1)>')).not.toMatch(/onerror/i);
  });

  it('writes a < that starts no tag as text and keeps ordinary markup', () => {
    expect(stripDangerousTags('<p>1 < 2</p>')).toBe('<p>1 &lt; 2</p>');
    expect(stripDangerousTags('<p class="a" data-x=\'b "c"\'>t</p><br/>'))
      .toBe('<p class="a" data-x="b &quot;c&quot;">t</p><br />');
  });
});

describe('isExternalResourceUrl', () => {
  it('detects http(s) and protocol-relative URLs including whitespace tricks', () => {
    expect(isExternalResourceUrl('https://x/p.gif')).toBe(true);
    expect(isExternalResourceUrl('\n\nhttps://x/p.gif')).toBe(true);
    expect(isExternalResourceUrl('ht\ttps://x')).toBe(true);
    expect(isExternalResourceUrl('//x/p.gif')).toBe(true);
    expect(isExternalResourceUrl('data:image/png;base64,AA')).toBe(false);
    expect(isExternalResourceUrl('cid:abc')).toBe(false);
    expect(isExternalResourceUrl(undefined)).toBe(false);
  });
});

describe('decodeCssEscapes / stripExternalStyleSheetCss', () => {
  it('decodes hex and char escapes', () => {
    expect(decodeCssEscapes('\\68ttp://x')).toBe('http://x');
    expect(decodeCssEscapes('\\000068ttp://x')).toBe('http://x');
    expect(decodeCssEscapes('\\75\\72\\6C(')).toBe('url(');
  });

  it('neutralises external url(), @import and @font-face sources', () => {
    const css = '.a{background:url("https://t/x.png")} @import "https://t/a.css"; @font-face{src:url(https://t/f.woff)} .b{color:red}';
    const out = stripExternalStyleSheetCss(css);
    expect(out).not.toContain('https://t');
    expect(out).toContain('.b{color:red}');
  });

  it('catches escaped url( keywords', () => {
    const css = '.a{background:\\75\\72\\6C(https://t/x.png)}';
    expect(stripExternalStyleSheetCss(css)).not.toContain('https://t');
  });

  it('returns the identical string when nothing is external', () => {
    const css = '.a{background:url(data:image/png;base64,AA)}';
    expect(stripExternalStyleSheetCss(css)).toBe(css);
  });
});

describe('blockExternalResources', () => {
  it('swaps external img src for a transparent pixel and hides it', () => {
    const { html, blocked } = blockExternalResources('<img src="https://t/p.gif" alt="logo">');
    expect(blocked).toBe(true);
    expect(html).toContain(`src="${TRANSPARENT_BLOCKED_PIXEL}"`);
    expect(html).toContain('data-blocked-src="https://t/p.gif"');
    expect(html).toContain('alt=""');
    expect(html).toContain('display:none');
  });

  it('covers srcset, <source>, poster, media src, background= and inline url()', () => {
    const input = [
      '<img srcset="https://t/a.png 1x, https://t/b.png 2x">',
      '<picture><source srcset="https://t/c.webp"></picture>',
      '<video poster="https://t/p.jpg" src="https://t/v.mp4"></video>',
      '<table background="https://t/bg.png"><tr><td style="background:url(https://t/x.png);color:red">x</td></tr></table>',
      '<div style="background-image:url(\\68ttps://t/esc.png)">y</div>',
    ].join('');
    const { html, blocked } = blockExternalResources(input);
    expect(blocked).toBe(true);
    // Only the data-blocked-* stashes may still carry the URLs.
    expect(html.replace(/data-blocked-[a-z]+="[^"]*"/g, '')).not.toContain('https://t/');
    expect(html).toContain('data-blocked-srcset');
    expect(html).toContain('data-blocked-poster');
    expect(html).toContain('data-blocked-background');
    expect(html).toContain('color:red');
  });

  it('catches whitespace-obfuscated src and leaves inline images alone', () => {
    const { html, blocked } = blockExternalResources('<img src="\n https://t/p.gif"><img src="cid:a"><img src="data:image/png;base64,AA">');
    expect(blocked).toBe(true);
    expect(html).toContain('src="cid:a"');
    expect(html).toContain('data:image/png;base64,AA');
  });

  it('scrubs <style> blocks', () => {
    const { html, blocked } = blockExternalResources('<style>.a{background:url(https://t/x.png)}</style>');
    expect(blocked).toBe(true);
    expect(html).not.toContain('https://t');
  });

  it('keeps CSS-escaped markup inside the scrubbed sheet', () => {
    const { html } = prepareEmailHtml(
      '<style>.a{background:url(https://t/x.png)} \\3c /style\\3e \\3c img src=x onerror=alert(1)\\3e </style><p>x</p>',
      { blockRemoteImages: true },
    );
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<\/style>\s*<img/i);
  });

  it('finds the image behind a stray quote, as the browser does', () => {
    const { html, blocked } = blockExternalResources('<img x"=y src=https://t/a.png>');
    expect(blocked).toBe(true);
    expect(html).toContain('data-blocked-src="https://t/a.png"');
  });

  it('reports nothing blocked for a local-only body', () => {
    const { html, blocked } = blockExternalResources('<p style="color:red">hi</p><img src="cid:x">');
    expect(blocked).toBe(false);
    expect(html).toContain('<p style="color:red">hi</p>');
    expect(hasRemoteContent('<p>hi</p>')).toBe(false);
    expect(hasRemoteContent('<img srcset="https://t/a.png 1x">')).toBe(true);
  });
});

describe('prepareEmailHtml', () => {
  it('uses the strict CSP only when blocking', () => {
    const strict = prepareEmailHtml('<p>x</p>', { blockRemoteImages: true });
    expect(strict.html).toContain('img-src data: cid:;');
    expect(strict.html).toContain("media-src 'none'");
    const open = prepareEmailHtml('<p>x</p>', { blockRemoteImages: false });
    expect(open.html).toContain('img-src data: cid: https: http:');
  });

  // The bridge scripts are injected by the WebView, so the page itself never
  // needs to run a script or an inline handler.
  it('runs no script or inline handler from the page in either mode', () => {
    for (const blockRemoteImages of [true, false]) {
      expect(prepareEmailHtml('<p>x</p>', { blockRemoteImages }).html).toContain("script-src 'none'");
    }
    expect(wrapPlainTextEmail('x')).toContain("script-src 'none'");
    expect(prepareEmailHtml('<p>x</p>').html).not.toMatch(/<script/i);
  });

  it('evaluates native dark mode once and reports the inversion decision', () => {
    const native = prepareEmailHtml('<style>@media (prefers-color-scheme: dark){body{color:#fff}}</style><p>x</p>', { isDark: true });
    expect(native.hasNativeDark).toBe(true);
    expect(native.applyInversion).toBe(false);
    expect(native.html).toContain('color-scheme: light dark');
    expect(native.html).not.toContain('invert(1)');

    const plain = prepareEmailHtml('<p>x</p>', { isDark: true });
    expect(plain.applyInversion).toBe(true);
    expect(plain.html).toContain('body { filter: invert(1) hue-rotate(180deg)');
    // Current webmail revision: background-image containers re-invert without the :has guard.
    expect(plain.html).toMatch(/\[style\*="background-image"\],\s*\[background\]\s*\{\s*filter: invert\(1\)/);

    const light = prepareEmailHtml('<p>x</p>', { isDark: false });
    expect(light.applyInversion).toBe(false);
  });

  it('reports blocked external content', () => {
    const res = prepareEmailHtml('<img src="https://t/p.gif">', { blockRemoteImages: true });
    expect(res.blockedExternal).toBe(true);
    const none = prepareEmailHtml('<p>hi</p>', { blockRemoteImages: true });
    expect(none.blockedExternal).toBe(false);
  });

  it('inlines cid images from the map and keeps a transparent placeholder otherwise', () => {
    const res = prepareEmailHtml('<img src="cid:a"><img src="cid:b">', { cidMap: { a: 'data:image/png;base64,AA' } });
    expect(res.html).toContain('src="data:image/png;base64,AA"');
    expect(res.html).toContain(`src="${TRANSPARENT_BLOCKED_PIXEL}"`);
  });

  // Stalwart (0.16 and 1.0) returns a part's Content-Type verbatim. A related
  // part declared as this type, with bytes that are no known image format,
  // used to put a live refresh meta into the reader (Android follows it
  // without a tap).
  it('never writes a hostile part type into the document', () => {
    const type = 'image/x"><meta http-equiv=refresh content=0,url=https://evil.example/>';
    const bytes = new TextEncoder().encode('ABC');
    const uri = `data:${sniffImageMime(bytes, type)};base64,QUJD`;
    for (const blockRemoteImages of [true, false]) {
      const { html } = prepareEmailHtml('<p>hi</p><img src="cid:p1">', { blockRemoteImages, cidMap: { p1: uri }, isDark: false });
      expect(html).not.toMatch(/<meta[^>]*refresh/i);
      expect(html).not.toContain('evil.example');
      expect(html).toContain(`<img src="${TRANSPARENT_BLOCKED_PIXEL}">`);
    }
    // A map value that is not an image type plus base64 is not used either.
    const { html } = prepareEmailHtml('<img src="cid:p1">', { cidMap: { p1: 'data:image/png;base64,AA"><b>x</b>' } });
    expect(html).not.toContain('<b>x</b>');
  });

  it('swaps cid references in src only, not in text or other attributes', () => {
    const { html } = prepareEmailHtml(
      '<img src="cid:abc" alt="cid:abc"><p>see cid:abc</p>',
      { cidMap: { abc: 'data:image/png;base64,AAA' } },
    );
    expect(html).toContain('<img src="data:image/png;base64,AAA" alt="cid:abc">');
    expect(html).toContain('<p>see cid:abc</p>');
  });

  it('tightens Word/Outlook HTML and drops the gutter for full-bleed canvases in auto mode', () => {
    const word = prepareEmailHtml('<div class="WordSection1"><p class="MsoNormal">x</p></div>');
    expect(word.html).toContain('p.MsoNormal');
    const bleed = prepareEmailHtml('<style>.x{}</style><table width="100%" bgcolor="#000"><tr><td>x</td></tr></table>', { messageSpacing: 'auto' });
    expect(bleed.html).toContain('padding: 0;');
    const gutter = prepareEmailHtml('<p>x</p>', { messageSpacing: 'always' });
    expect(gutter.html).toContain('padding: 16px;');
    const edge = prepareEmailHtml('<p>x</p>', { messageSpacing: 'edge' });
    expect(edge.html).toContain('padding: 0;');
  });

  it('neutralises height:100% wrappers', () => {
    expect(prepareEmailHtml('<p>x</p>').html).toContain('[style*="height:100%"]');
  });

  it('caps images and tables at the pane without overriding a sender max-width (#790)', () => {
    const { html } = prepareEmailHtml(
      '<img width="200" height="134" style="display:block; max-height:134px; max-width:200px; width:100%;">'
      + '<table style="max-width:300px; width:100%"><tr><td>x</td></tr></table>',
    );
    // An unconditional !important cap would beat the inline max-width.
    expect(html).not.toMatch(/(^|[\s}])img\s*\{[^}]*max-width:\s*100%\s*!important/);
    expect(html).not.toMatch(/(^|[\s}])table\s*\{[^}]*max-width:\s*100%\s*!important/);
    expect(html).toContain('img:not([style*="max-width"]) { max-width: 100% !important; }');
    expect(html).toContain('img[style*="max-width"] { max-width: 100%; }');
    expect(html).toContain('img { height: auto !important; }');
    expect(html).toContain('table:not([style*="max-width"]) { max-width: 100% !important; }');
    expect(html).toContain('table[style*="max-width"] { max-width: 100%; }');
    // The sender's sizing reaches the document untouched.
    expect(html).toContain('max-height:134px; max-width:200px; width:100%;');
    expect(html).toContain('style="max-width:300px; width:100%"');
  });

  it('lets the content pick its text direction', () => {
    expect(prepareEmailHtml('<p>مرحبا بالعالم.</p>').html).toContain('<body dir="auto">');
  });

  it('keeps a direction the email declares on its own html or body tag', () => {
    const body = prepareEmailHtml('<body dir="rtl"><p>Newsletter مرحبا</p></body>').html;
    expect(body).not.toContain('dir="auto"');
    expect(body).toContain('<body dir="rtl">');
    const root = prepareEmailHtml('<html lang="ar" dir="rtl"><body><p>x</p></body></html>').html;
    expect(root).not.toContain('dir="auto"');
    // A dir on an inner element is not a document direction.
    expect(prepareEmailHtml('<p dir="rtl">x</p>').html).toContain('<body dir="auto">');
  });
});

describe('wrapPlainTextEmail', () => {
  it('uses the app font by default and monospace on request', () => {
    expect(wrapPlainTextEmail('x', { font: 'sans' })).toContain('-apple-system');
    expect(wrapPlainTextEmail('x', { font: 'mono' })).toContain('ui-monospace');
    expect(wrapPlainTextEmail('x')).not.toContain('ui-monospace');
  });

  it('lets the content pick its text direction', () => {
    expect(wrapPlainTextEmail('مرحبا بالعالم.')).toContain('<body dir="auto">');
  });
});

describe('hasNativeDarkMode', () => {
  it('detects prefers-color-scheme rules', () => {
    expect(hasNativeDarkMode('@media (prefers-color-scheme:dark){}')).toBe(true);
    expect(hasNativeDarkMode('<p>x</p>')).toBe(false);
  });
});

describe('sniffImageMime', () => {
  it('recognises PNG/JPEG/GIF/WebP magic bytes', () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'application/octet-stream')).toBe('image/png');
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp');
  });

  it('falls back to a declared image type, else octet-stream', () => {
    expect(sniffImageMime(new Uint8Array([1, 2, 3]), 'image/tiff')).toBe('image/tiff');
    expect(sniffImageMime(new Uint8Array([1, 2, 3]), 'application/octet-stream')).toBe('application/octet-stream');
  });

  it('uses only a plain image type from the part', () => {
    expect(sniffImageMime(new Uint8Array([1, 2, 3]), 'image/x"><meta http-equiv=refresh content=0,url=https://evil.example/>'))
      .toBe('application/octet-stream');
    expect(sniffImageMime(new Uint8Array([1, 2, 3]), 'image/svg+xml; charset=utf-8')).toBe('image/svg+xml');
  });
});

describe('reading width on a wide pane', () => {
  it('caps HTML and plain-text bodies only above the tablet breakpoint', () => {
    const html = wrapEmailHtml('<p>Hello</p>');
    expect(html).toMatch(/@media \(min-width: 840px\) \{\s*body \{ max-width: 720px;/);
    const plain = wrapPlainTextEmail('Hello');
    expect(plain).toContain('@media (min-width: 840px) { body { max-width: 80ch; } }');
  });
});

describe('isUserLinkNavigation', () => {
  it('opens only tapped links in the top frame on iOS', () => {
    expect(isUserLinkNavigation({ navigationType: 'click', isTopFrame: true }, 'ios')).toBe(true);
    expect(isUserLinkNavigation({ navigationType: 'other', isTopFrame: true }, 'ios')).toBe(false);
    expect(isUserLinkNavigation({ navigationType: 'formsubmit' }, 'ios')).toBe(false);
    expect(isUserLinkNavigation({ navigationType: 'click', isTopFrame: false }, 'ios')).toBe(false);
  });

  it('keeps taps working on Android, which always reports other', () => {
    expect(isUserLinkNavigation({ navigationType: 'other', isTopFrame: true }, 'android')).toBe(true);
    expect(isUserLinkNavigation({ navigationType: 'other', isTopFrame: false }, 'android')).toBe(false);
  });
});
