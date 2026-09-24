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
  hasNativeDarkMode,
  sniffImageMime,
  TRANSPARENT_BLOCKED_PIXEL,
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
});

describe('wrapPlainTextEmail', () => {
  it('uses the app font by default and monospace on request', () => {
    expect(wrapPlainTextEmail('x', { font: 'sans' })).toContain('-apple-system');
    expect(wrapPlainTextEmail('x', { font: 'mono' })).toContain('ui-monospace');
    expect(wrapPlainTextEmail('x')).not.toContain('ui-monospace');
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
});
