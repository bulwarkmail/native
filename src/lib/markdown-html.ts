// Markdown to HTML for the file preview. Covers what README files and notes
// use: ATX and setext headings, paragraphs, emphasis, strikethrough, inline
// and fenced code, block quotes, nested lists and task lists, GFM tables,
// rules, links, images and autolinks. Every piece of source text is escaped
// and only http(s)/mailto URLs survive, so the output carries no markup the
// author wrote; it is still shown through the mail-body sanitiser, which
// blocks remote images like it does for mail.

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function safeUrl(raw: string): string | null {
  const url = raw.trim().replace(/^<|>$/g, '');
  if (/^(https?:|mailto:)/i.test(url)) return url;
  // Relative links point into a repository the preview doesn't have.
  return null;
}

/** Inline markup of one block's text. */
export function renderInline(src: string): string {
  // Code spans first: nothing inside them is markup.
  const codes: string[] = [];
  let s = src.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks, code: string) => {
    codes.push(`<code>${escapeHtml(code.trim())}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // Backslash escapes.
  const escaped: string[] = [];
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_m, ch: string) => {
    escaped.push(escapeHtml(ch));
    return `\u0001${escaped.length - 1}\u0001`;
  });
  // Links and images, before escaping so the brackets are still there.
  const links: string[] = [];
  const stash = (html: string) => {
    links.push(html);
    return `\u0002${links.length - 1}\u0002`;
  };
  s = s.replace(/!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"([^"]*)")?\s*\)/g, (_m, alt: string, url: string, title?: string) => {
    const href = safeUrl(url);
    if (!href) return stash(escapeHtml(alt));
    const t = title ? ` title="${escapeHtml(title)}"` : '';
    return stash(`<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"${t}>`);
  });
  s = s.replace(/\[([^\]]+)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"([^"]*)")?\s*\)/g, (_m, text: string, url: string, title?: string) => {
    const href = safeUrl(url);
    const inner = renderEmphasis(escapeHtml(text));
    if (!href) return stash(inner);
    const t = title ? ` title="${escapeHtml(title)}"` : '';
    return stash(`<a href="${escapeHtml(href)}"${t}>${inner}</a>`);
  });
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s>]+)>/gi, (_m, url: string) => stash(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (_m, lead: string, url: string) => (
    lead + stash(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`)
  ));

  s = renderEmphasis(escapeHtml(s));
  // Hard line breaks: two trailing spaces or a backslash.
  s = s.replace(/ {2,}\n|\\\n/g, '<br>\n');

  return s
    .replace(/\u0002(\d+)\u0002/g, (_m, i: string) => links[Number(i)])
    .replace(/\u0001(\d+)\u0001/g, (_m, i: string) => escaped[Number(i)])
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

function renderEmphasis(s: string): string {
  return s
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(^|[^\w*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_DELIM = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

function renderList(lines: string[], start: number): { html: string; next: number } {
  const first = LIST_ITEM.exec(lines[start])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    // The item's own lines: continuation text and deeper-indented blocks.
    const body: string[] = [m[3]];
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') {
        const nextLine = lines[i + 1];
        if (nextLine !== undefined && /^\s+/.test(nextLine) && nextLine.search(/\S/) > indent) {
          body.push('');
          i += 1;
          continue;
        }
        break;
      }
      const sub = LIST_ITEM.exec(line);
      if (sub && sub[1].length <= indent) break;
      if (!sub && line.search(/\S/) <= indent && isBlockStart(line)) break;
      body.push(line.slice(Math.min(line.search(/\S/), indent + 2)));
      i += 1;
    }
    let content = body.join('\n');
    let task = '';
    const box = /^\[([ xX])\][ \t]+/.exec(content);
    if (box) {
      // A glyph, not an <input>: the mail sanitiser drops form controls.
      task = box[1] === ' ' ? '☐ ' : '☑ ';
      content = content.slice(box[0].length);
    }
    const inner = renderBlocks(content.split('\n'), true);
    items.push(`<li${task ? ' class="task"' : ''}>${task}${inner}</li>`);
    if (lines[i] !== undefined && lines[i].trim() === '') {
      // A blank line between items keeps the list going.
      const after = LIST_ITEM.exec(lines[i + 1] ?? '');
      if (after && after[1].length === indent) i += 1;
    }
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  return { html: `<${tag}${startAttr}>${items.join('')}</${tag}>`, next: i };
}

function renderBlocks(lines: string[], tight = false): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      const lang = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : '';
      out.push(`<pre><code${lang}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') {
        const q = QUOTE.exec(lines[i]);
        quoted.push(q ? q[1] : lines[i]);
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(quoted)}</blockquote>`);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const list = renderList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    if (/^ {4,}\S/.test(line)) {
      const code: string[] = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || lines[i].trim() === '')) {
        code.push(lines[i].slice(4));
        i += 1;
      }
      while (code.length && code[code.length - 1].trim() === '') code.pop();
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return left ? 'left' : '';
      });
      const cell = (tag: string, text: string, col: number) => {
        const a = align[col] ? ` style="text-align:${align[col]}"` : '';
        return `<${tag}${a}>${renderInline(text)}</${tag}>`;
      };
      const rows: string[] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        rows.push(`<tr>${head.map((_h, col) => cell('td', cells[col] ?? '', col)).join('')}</tr>`);
        i += 1;
      }
      out.push(`<table><thead><tr>${head.map((h, col) => cell('th', h, col)).join('')}</tr></thead>`
        + `<tbody>${rows.join('')}</tbody></table>`);
      continue;
    }

    // Paragraph: until a blank line or another block; a setext underline
    // turns it into a heading.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && (para.length === 0 || !isBlockStart(lines[i]))) {
      if (para.length > 0 && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i])) break;
      para.push(lines[i]);
      i += 1;
    }
    const setext = i < lines.length ? /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[i]) : null;
    if (setext && para.length > 0) {
      const level = setext[1].startsWith('=') ? 1 : 2;
      out.push(`<h${level}>${renderInline(para.join('\n').trim())}</h${level}>`);
      i += 1;
      continue;
    }
    const text = renderInline(para.map((l) => l.replace(/^ {1,3}/, '')).join('\n'));
    // List items keep their text bare, as in a tight list.
    out.push(tight ? text : `<p>${text}</p>`);
  }
  return out.join('\n');
}

const STYLE = `
body{font-family:-apple-system,system-ui,Roboto,sans-serif;font-size:15px;line-height:1.55;word-wrap:break-word}
h1,h2{border-bottom:1px solid rgba(128,128,128,.3);padding-bottom:.25em}
h1{font-size:1.6em}h2{font-size:1.35em}h3{font-size:1.15em}
h1,h2,h3,h4,h5,h6{margin:1.1em 0 .5em;line-height:1.25}
p,ul,ol,blockquote,pre,table{margin:0 0 .9em}
ul,ol{padding-left:1.6em}li>p{margin:0 0 .4em}li.task{list-style:none;margin-left:-1.3em}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em;background:rgba(128,128,128,.15);padding:.1em .3em;border-radius:4px}
pre{background:rgba(128,128,128,.12);padding:.8em;border-radius:6px;overflow-x:auto}
pre code{background:none;padding:0;font-size:.85em}
blockquote{margin-left:0;padding-left:1em;border-left:4px solid rgba(128,128,128,.4);color:rgba(128,128,128,1)}
table{border-collapse:collapse;display:block;overflow-x:auto}
th,td{border:1px solid rgba(128,128,128,.35);padding:.35em .7em}th{background:rgba(128,128,128,.1)}
hr{border:0;border-top:1px solid rgba(128,128,128,.35);margin:1.4em 0}
img{max-width:100%}
`;

/** A Markdown file as an HTML document for the preview. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${renderBlocks(lines)}</body></html>`;
}
