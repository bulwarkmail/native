// Every remote reference the page's policy blocks also shows the banner, each
// attribute judged on its value as the browser reads it (character references
// decoded before anything is split), and the full pipeline (prepareEmailHtml)
// leaves nothing remote in what loads.
import { describe, expect, it } from 'vitest';
import { blockExternalResources, hasRemoteContent, prepareEmailHtml } from '../email-html';

const T = 'https://t.example';
const DATA = 'data:image/png;base64,AAAA';

describe('remote references the banner knows about', () => {
  it.each([
    ['img src', `<img src="${T}/a.png">`],
    ['img src with a character reference', `<img src="&#104;ttps://t.example/a.png">`],
    ['srcset, external second candidate', `<img src="${DATA}" srcset="${DATA} 1x, ${T}/a.png 2x">`],
    ['srcset, candidates split by a character reference comma', `<img src="${DATA}" srcset="${DATA} 1x&#44;${T}/a.png 2x">`],
    ['srcset, candidates split by &comma;', `<img src="${DATA}" srcset="${DATA} 1x&comma;${T}/a.png 2x">`],
    ['picture source srcset', `<picture><source srcset="${T}/a.webp"><img src="${DATA}"></picture>`],
    ['video poster', `<video poster="${T}/p.png"></video>`],
    ['audio src', `<audio src="${T}/a.mp3"></audio>`],
    ['video source src', `<video><source src="${T}/v.mp4"></video>`],
    ['video track src', `<video><track src="${T}/c.vtt"></video>`],
    ['background attribute', `<table background="${T}/bg.png"><tr><td>x</td></tr></table>`],
    ['background attribute with a reference', `<td background="&#x68;ttps://t.example/bg.png">x</td>`],
    ['protocol-relative url() in a style', `<div style="background:url(//t.example/a.png)">x</div>`],
    ['url( with a tab reference before the address', `<div style="background:url(&Tab;${T}/a.png)">x</div>`],
    ['url( with a newline reference before the address', `<div style="background:url(&NewLine;${T}/a.png)">x</div>`],
    ['@import string in a style sheet', `<style>@import "${T}/a.css";</style><p>x</p>`],
    ['@import url() in a style sheet', `<style>@import url(${T}/a.css);</style><p>x</p>`],
    ['@font-face src in a style sheet', `<style>@font-face{font-family:x;src:url(${T}/f.woff2)}</style><p>x</p>`],
    ['image-set with an escaped string', String.raw`<div style="background:image-set('\68ttps://t.example/a.png' 1x)">x</div>`],
    ['list-style-image', `<ul style="list-style-image:url(${T}/b.png)"><li>x</li></ul>`],
    ['border-image', `<div style="border-image:url(${T}/b.png) 30 round">x</div>`],
    ['cursor', `<div style="cursor:url(${T}/c.cur),auto">x</div>`],
  ])('%s', (_name, html) => {
    expect(hasRemoteContent(html)).toBe(true);
  });

  // The comma between srcset candidates, the space before a descriptor and the
  // colon of the scheme, each as a reference: decimal and hex, with and without
  // the semicolon, and by name.
  const comma = ['&#44;', '&#44', '&#x2C;', '&#x2c', '&#X2C;', '&comma;'];
  const space = ['&#32;', '&#32', '&#x20;', '&#x20', '&Tab;', '&NewLine;'];
  const colon = ['&#58;', '&#58', '&#x3A;', '&#x3a', '&colon;'];
  it.each(comma)('srcset with the comma written as %s', (ref) => {
    expect(hasRemoteContent(`<img src="${DATA}" srcset="${DATA} 1x${ref}${T}/a.png 2x">`)).toBe(true);
  });
  it.each(space)('srcset with the space before the descriptor written as %s', (ref) => {
    expect(hasRemoteContent(`<img src="${DATA}" srcset="${DATA} 1x,${ref}${T}/a.png${ref}2x">`)).toBe(true);
  });
  it.each(colon)('the scheme\'s colon written as %s in src, srcset, poster, background and style', (ref) => {
    const url = `https${ref}//t.example/a.png`;
    for (const html of [
      `<img src="${url}">`,
      `<img src="${DATA}" srcset="${DATA} 1x, ${url} 2x">`,
      `<video poster="${url}"></video>`,
      `<td background="${url}">x</td>`,
      `<div style="background:url(${url})">x</div>`,
    ]) {
      expect(hasRemoteContent(html), html).toBe(true);
    }
  });

  it('nothing remote is left in the document the WebView loads while blocked', () => {
    const html = [
      `<img src="&#104;ttps://t.example/a.png">`,
      `<img src="${DATA}" srcset="${DATA} 1x&#44;${T}/b.png 2x">`,
      `<div style="background:url(&Tab;${T}/c.png)">x</div>`,
      `<style>p{background:image-set("${T}/d.png" 1x)}</style><p>x</p>`,
      `<video poster="${T}/e.png"></video>`,
    ].join('');
    const res = prepareEmailHtml(html, { blockRemoteImages: true, isDark: false, cidMap: {} });
    const body = res.html.slice(res.html.indexOf('<body'));
    // Strip what the pass stashes for "Load images", then look for live remote references.
    const live = body.replace(/data-blocked-[a-z]+="[^"]*"/g, '');
    expect(live).not.toMatch(/t\.example/);
  });

  it('no banner for what never leaves the device', () => {
    expect(hasRemoteContent(`<img src="cid:part1">`)).toBe(false);
    expect(hasRemoteContent(`<img src="${DATA}" srcset="${DATA} 1x">`)).toBe(false);
    expect(hasRemoteContent(`<a href="${T}/page">link</a>`)).toBe(false);
    expect(hasRemoteContent(`<div style="font-family:'A&amp;B'">x</div>`)).toBe(false);
    // A name the browser doesn't read without its semicolon stays text: no scheme.
    expect(hasRemoteContent(`<img src="https&colon//t.example/a.png">`)).toBe(false);
    expect(blockExternalResources(`<img src="${DATA}" srcset="${DATA} 1x&amp;#44;${T}/a.png 2x">`).blocked).toBe(false);
  });
});
