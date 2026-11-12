// Remote references the page's policy blocks are also found by the detection
// pass: otherwise nothing loads, but the "Images and external content have
// been blocked" banner and its "Load images" button never appear, so the user
// can't tell why the mail looks broken and can't load the content.
import { describe, expect, it } from 'vitest';
import { blockExternalResources, hasRemoteContent } from '../email-html';

const T = 'https://t.example';

describe('remote content the banner knows about', () => {
  it.each([
    ['a character reference in an inline style URL', `<div style="background:url(&#104;ttps://t.example/a.png)">x</div>`],
    ['image-set() with a string', `<div style="background-image:image-set('${T}/a.png' 1x)">x</div>`],
    ['image-set() with a string in a style sheet', `<style>p{background:image-set("${T}/a.png" 1x)}</style><p>x</p>`],
    ['an unclosed url( in an inline style', `<div style="background:url('${T}/a.png">x</div>`],
    ['an unclosed url( at the end of a style sheet', `<style>p{background:url(${T}/a.png</style><p>x</p>`],
    ['named character references in an inline style', `<div style="background:url&lpar;https&colon;&sol;&sol;t.example/a.png&rpar;">x</div>`],
    ['-webkit-image-set() with a string', `<div style="background:-webkit-image-set(&quot;${T}/a.png&quot; 1x)">x</div>`],
    ['cross-fade() of remote images', `<div style="background:cross-fade(url(${T}/a.png), url(${T}/b.png), 50%)">x</div>`],
    ['url( spelled with a CSS escape', `<div style="background:u\\72l(${T}/a.png)">x</div>`],
    ['a CSS comment before the reference', `<style>p{background:/**/url(${T}/a.png)}</style><p>x</p>`],
    ['a CSS comment inside image-set()', `<style>p{background:image-set(/**/"${T}/a.png" 1x)}</style><p>x</p>`],
    ['upper case in a style sheet', `<style>P{BACKGROUND:IMAGE-SET('${T.toUpperCase()}/A.PNG' 1X)}</style><p>x</p>`],
    ['an unclosed url( with a character reference', `<div style="background:url(&#x68;ttps://t.example/a.png">x</div>`],
  ])('%s', (_name, html) => {
    expect(hasRemoteContent(html)).toBe(true);
    expect(blockExternalResources(html).blocked).toBe(true);
  });

  it('cuts the remote reference out of the style and keeps the rest', () => {
    const { html } = blockExternalResources(`<div style="color:red;background:url(&#104;ttps://t.example/a.png) no-repeat">x</div>`);
    expect(html).toContain('style="color:red;background:url() no-repeat"');
    const set = blockExternalResources(`<div style="background:image-set('${T}/a.png' 1x, 'cid:local' 2x)">x</div>`).html;
    expect(set).toContain(`image-set(&quot;&quot; 1x, 'cid:local' 2x)`);
  });

  it('writes a value back so the browser reads what the check read', () => {
    // &amp;#104; is the text "&#104;" to the browser: not a URL, and still not one afterwards.
    const { html, blocked } = blockExternalResources(
      `<div style="background:url(${T}/a.png);content:'&amp;#104;ttps'">x</div>`,
    );
    expect(blocked).toBe(true);
    expect(html).toContain(`content:'&amp;#104;ttps'`);
  });

  it.each([
    ['an inline image', `<div style="background:url(data:image/png;base64,AAAA)">x</div>`],
    ['a string outside image-set()', `<div style="font-family:'${T}'">x</div>`],
    ['a local image in image-set()', `<style>p{background:image-set("cid:logo" 1x)}</style><p>x</p>`],
    ['a relative url( left open', `<div style="background:url(a.png">x</div>`],
  ])('does not count %s', (_name, html) => {
    expect(hasRemoteContent(html)).toBe(false);
  });
});
