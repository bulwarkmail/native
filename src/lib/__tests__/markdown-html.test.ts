import { describe, it, expect } from 'vitest';
import { markdownToHtml, renderInline } from '../markdown-html';

const body = (md: string) => {
  const html = markdownToHtml(md);
  return html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
};

describe('markdownToHtml', () => {
  it('renders headings, paragraphs and rules', () => {
    expect(body('# Title\n\nSome text\nwrapped.\n\n---\n\n### Small ###'))
      .toBe('<h1>Title</h1>\n<p>Some text\nwrapped.</p>\n<hr>\n<h3>Small</h3>');
    expect(body('Big\n===\n\nSmaller\n---')).toBe('<h1>Big</h1>\n<h2>Smaller</h2>');
  });

  it('renders nested and ordered lists and task items', () => {
    expect(body('- one\n- two\n  - nested\n- three')).toBe(
      '<ul><li>one</li><li>two\n<ul><li>nested</li></ul></li><li>three</li></ul>',
    );
    expect(body('3. c\n4. d')).toBe('<ol start="3"><li>c</li><li>d</li></ol>');
    expect(body('- [x] done\n- [ ] open')).toBe('<ul><li class="task">\u2611 done</li><li class="task">\u2610 open</li></ul>');
  });

  it('keeps fenced and indented code verbatim and escaped', () => {
    expect(body('```js\nconst a = "<b>";\n**not bold**\n```')).toBe(
      '<pre><code class="language-js">const a = &quot;&lt;b&gt;&quot;;\n**not bold**</code></pre>',
    );
    expect(body('    x < 1')).toBe('<pre><code>x &lt; 1</code></pre>');
  });

  it('renders quotes and GFM tables with alignment', () => {
    expect(body('> quoted\n> **text**')).toBe('<blockquote><p>quoted\n<strong>text</strong></p></blockquote>');
    expect(body('| a | b |\n|:--|--:|\n| 1 | 2 |')).toBe(
      '<table><thead><tr><th style="text-align:left">a</th><th style="text-align:right">b</th></tr></thead>'
      + '<tbody><tr><td style="text-align:left">1</td><td style="text-align:right">2</td></tr></tbody></table>',
    );
  });

  it('escapes raw HTML instead of passing it through', () => {
    expect(body('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(body('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });
});

describe('renderInline', () => {
  it('renders emphasis, code and strikethrough', () => {
    expect(renderInline('**b** *i* _j_ `c*d*` ~~s~~')).toBe(
      '<strong>b</strong> <em>i</em> <em>j</em> <code>c*d*</code> <del>s</del>',
    );
    expect(renderInline('snake_case_name stays')).toBe('snake_case_name stays');
    expect(renderInline('\\*literal\\*')).toBe('*literal*');
  });

  it('links only to web and mail URLs', () => {
    expect(renderInline('[site](https://example.org "T")')).toBe('<a href="https://example.org" title="T">site</a>');
    expect(renderInline('[x](javascript:alert(1))')).toBe('x)');
    expect(renderInline('[doc](./docs/a.md)')).toBe('doc');
    expect(renderInline('see https://example.org/a.')).toBe('see <a href="https://example.org/a">https://example.org/a</a>.');
    expect(renderInline('<mailto:a@b.c>')).toBe('<a href="mailto:a@b.c">mailto:a@b.c</a>');
  });

  it('keeps image URLs for the sanitiser and drops unsafe ones', () => {
    expect(renderInline('![logo](https://example.org/l.png)')).toBe('<img src="https://example.org/l.png" alt="logo">');
    expect(renderInline('![x](data:image/png;base64,AAA)')).toBe('x');
  });

  it('escapes attribute breakouts in link text and titles', () => {
    expect(renderInline('[a"b](https://e.org "x\\" onmouseover=\\"y")')).not.toMatch(/onmouseover="/);
  });
});
