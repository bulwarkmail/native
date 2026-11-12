/**
 * Links in a message the user reported as phishing ($phishing, RFC 9051
 * §2.3.2: clients should warn and disable links) are turned off: each `<a>`
 * and `<area>` loses its address, so it can't be tapped, and says that it
 * is off. Port of the webmail's lib/phishing-links.ts without a DOM: it runs
 * on the finished body document (sanitised HTML or the plain-text page),
 * rewrites only the link tags and copies everything else as it is.
 */

import type { Email } from '../api/types';

/** RFC 9051 §2.3.2: the user reported the message as phishing. */
export const PHISHING_KEYWORD = '$phishing';

/** Whether the message carries the phishing mark. */
export function isPhishingMarked(email: Pick<Email, 'keywords'> | null | undefined): boolean {
  return email?.keywords?.[PHISHING_KEYWORD] === true;
}

/** What a turned-off link says: its tooltip, and the note a screen reader hears after its text. */
export interface LinksOffText {
  title: string;
  note: string;
}

const LINK_OFF_STYLE = 'color:inherit !important;text-decoration:underline dotted !important;cursor:not-allowed !important';
const NOTE_STYLE = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
const DROPPED = new Set(['href', 'xlink:href', 'target', 'rel', 'ping', 'download', 'tabindex', 'title', 'aria-disabled', 'data-link-off']);
const RAW_TEXT = new Set(['style', 'script', 'title', 'textarea', 'xmp', 'noscript']);

interface Attr { name: string; value: string | null }

const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';
const isAlpha = (ch: string | undefined) => !!ch && /[A-Za-z]/.test(ch);

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Reads the tag whose name starts at `i`: its name, attributes and the index after its `>`. */
function readTag(html: string, i: number): { name: string; attrs: Attr[]; end: number } | null {
  const n = html.length;
  let j = i;
  while (j < n && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>') j++;
  const name = html.slice(i, j);
  const attrs: Attr[] = [];
  while (j < n) {
    const ch = html[j];
    if (isSpace(ch) || ch === '/') { j++; continue; }
    if (ch === '>') return { name, attrs, end: j + 1 };
    const start = j++;
    while (j < n && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') j++;
    const attrName = html.slice(start, j);
    while (j < n && isSpace(html[j])) j++;
    if (html[j] !== '=') { attrs.push({ name: attrName, value: null }); continue; }
    j++;
    while (j < n && isSpace(html[j])) j++;
    const q = html[j];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, j + 1);
      if (close < 0) return null;
      attrs.push({ name: attrName, value: html.slice(j + 1, close) });
      j = close + 1;
    } else {
      const s = j;
      while (j < n && !isSpace(html[j]) && html[j] !== '>') j++;
      attrs.push({ name: attrName, value: html.slice(s, j) });
    }
  }
  return null;
}

function linkOffTag(name: string, attrs: Attr[], text: LinksOffText, isAnchor: boolean): string {
  const kept = attrs.filter((a) => !DROPPED.has(a.name.toLowerCase()));
  const out = kept.filter((a) => a.name.toLowerCase() !== 'style')
    .map((a) => (a.value === null ? a.name : `${a.name}="${a.value.replace(/"/g, '&quot;')}"`));
  out.push('data-link-off', 'aria-disabled="true"', `title="${escapeAttr(text.title)}"`);
  if (isAnchor) {
    const style = kept.find((a) => a.name.toLowerCase() === 'style')?.value?.trim();
    out.push(`style="${style ? `${style.replace(/"/g, '&quot;').replace(/;?$/, ';')}` : ''}${LINK_OFF_STYLE}"`);
  } else {
    const style = kept.find((a) => a.name.toLowerCase() === 'style');
    if (style?.value) out.push(`style="${style.value.replace(/"/g, '&quot;')}"`);
  }
  return `<${name} ${out.join(' ')}>`;
}

/** `html` (a fragment or a whole document) with every link turned off. */
export function turnOffLinks(html: string, text: LinksOffText): string {
  if (!html || !/<(a|area)[\s/>]/i.test(html)) return html;
  const note = `<span data-link-off-note style="${NOTE_STYLE}"> ${escapeText(text.note)}</span>`;
  const n = html.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const stop = end < 0 ? n : end + 3;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }
    const closing = html[lt + 1] === '/';
    const nameAt = closing ? lt + 2 : lt + 1;
    if (!isAlpha(html[nameAt])) { out += '<'; i = lt + 1; continue; }
    const tag = readTag(html, nameAt);
    if (!tag) { out += html.slice(lt); break; }
    const lower = tag.name.toLowerCase();
    if (closing) {
      out += (lower === 'a' ? note : '') + html.slice(lt, tag.end);
      i = tag.end;
      continue;
    }
    if (lower === 'a' || lower === 'area') {
      out += linkOffTag(tag.name, tag.attrs, text, lower === 'a');
      i = tag.end;
      continue;
    }
    out += html.slice(lt, tag.end);
    i = tag.end;
    if (RAW_TEXT.has(lower)) {
      // A sheet or script is copied as it is, up to its end tag.
      const close = new RegExp(`</${lower}[\\s/>]`, 'i');
      const m = close.exec(html.slice(i));
      const stop = m ? i + m.index : n;
      out += html.slice(i, stop);
      i = stop;
    }
  }
  return out;
}
