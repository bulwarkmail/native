/**
 * Quote collapsing for the email viewer (webmail #480, port of
 * `lib/quote-collapse.ts`).
 *
 * When a reply carries the original message as a trailing quote, hide it by
 * default and inject a Gmail-style "•••" pill that toggles it.
 *
 * The HTML path runs inside the WebView, so it ships as an injected script
 * (`buildQuoteCollapseScript`) rather than a DOM function - the page has no
 * app CSS and the RN side has no DOM. Plain-text bodies are collapsed at
 * string level (`collapsePlainTextQuotes`) with a script-less
 * <details>/<summary> toggle.
 *
 * Two kinds of markers:
 *  - container: an element that wraps the entire quoted original. Hiding the
 *    element hides the quote.
 *  - separator: a header/divider element ("From: …" block, attribution line)
 *    that the quoted original FOLLOWS as siblings. Everything from the marker
 *    to the end of the body is hidden.
 */

export interface QuoteCollapseLabels {
  /** Accessible label while collapsed, e.g. "Show quoted text". */
  show: string;
  /** Accessible label while expanded, e.g. "Hide quoted text". */
  hide: string;
}

// Document order decides which marker wins when several are present.
export const QUOTE_CONTAINER_SELECTORS = [
  // Bulwark's own reply/forward island.
  'div[data-quoted-html]',
  // Gmail: gmail_quote_container (2023+) wraps gmail_attr + gmail_quote.
  'div.gmail_quote_container',
  'div.gmail_quote',
  // Apple Mail / Thunderbird quoted body.
  'blockquote[type="cite"]',
  'div.yahoo_quoted',
  'blockquote.protonmail_quote',
  'div.protonmail_quote',
];

export const QUOTE_SEPARATOR_SELECTORS = [
  // Outlook (desktop + OWA): "From:/Sent:/To:/Subject:" header block; the
  // quoted message body follows as siblings.
  '#divRplyFwdMsg',
  '#appendonsend',
  // Thunderbird attribution line ("On …, X wrote:"); the blockquote follows.
  'div.moz-cite-prefix',
];

/** Marks the injected toggle button (also the idempotence guard). */
export const QUOTE_TOGGLE_ATTR = 'data-quote-toggle';
/** Marks elements hidden by the collapse; value stores the original inline display. */
export const QUOTE_COLLAPSED_ATTR = 'data-quote-collapsed';

/**
 * The in-page implementation of `setupQuoteCollapse`, as a self-contained
 * script for `injectedJavaScript`. Idempotent per document. Uses inline
 * styles only (style-src allows inline; neutral greys read fine after the
 * dark-mode invert filter too).
 */
export function buildQuoteCollapseScript(labels: QuoteCollapseLabels): string {
  const cfg = JSON.stringify({
    containers: QUOTE_CONTAINER_SELECTORS,
    separators: QUOTE_SEPARATOR_SELECTORS,
    toggleAttr: QUOTE_TOGGLE_ATTR,
    collapsedAttr: QUOTE_COLLAPSED_ATTR,
    show: labels.show,
    hide: labels.hide,
  });
  return `
(function () {
  var C = ${cfg};
  var doc = document;
  var body = doc.body;
  if (!body || body.querySelector('[' + C.toggleAttr + ']')) return;
  var all = C.containers.concat(C.separators).join(',');

  function hasVisibleContent(marker, side) {
    var bit = side === 'before' ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
    var walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var rel = marker.compareDocumentPosition(node);
      if (rel & Node.DOCUMENT_POSITION_CONTAINED_BY) continue;
      if (!(rel & bit)) continue;
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.nodeValue || '').trim() !== '') return true;
      } else if (node.tagName === 'IMG') {
        if (!node.hasAttribute('data-blocked-src') && node.style.display !== 'none') return true;
      }
    }
    return false;
  }
  // One walk in document order, remembering the last non-blank text: a
  // blockquote is reached before its own text, so that is the text preceding
  // it. Walking from the start again per blockquote took quadratic time and
  // froze the reader on a mail full of blockquotes (webmail quote-collapse.ts).
  function findAttributedBlockquote() {
    var walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    var last = null;
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        var text = (node.nodeValue || '').trim();
        if (text !== '') last = text;
        continue;
      }
      if (node.tagName !== 'BLOCKQUOTE') continue;
      if (node.parentElement && node.parentElement.closest('blockquote')) continue;
      if (last !== null && /:$/.test(last)) return node;
    }
    return null;
  }
  function hideElement(el) {
    el.setAttribute(C.collapsedAttr, el.style.display || '');
    el.style.display = 'none';
  }
  function collectSeparatorRange(marker) {
    var range = [marker];
    var el = marker;
    while (el && el !== body) {
      for (var sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) range.push(sib);
      el = el.parentElement;
    }
    return range;
  }

  var marker = body.querySelector(all) || findAttributedBlockquote();
  if (!marker) return;
  var isSeparator = C.separators.some(function (sel) { return marker.matches(sel); });
  if (!hasVisibleContent(marker, 'before')) return;
  if (!isSeparator && hasVisibleContent(marker, 'after')) return;

  var hidden = isSeparator ? collectSeparatorRange(marker) : [marker];
  var button = doc.createElement('button');
  button.type = 'button';
  button.setAttribute(C.toggleAttr, '');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', C.show);
  button.title = C.show;
  button.textContent = '\\u2022\\u2022\\u2022';
  button.style.cssText =
    'display:inline-block;margin:12px 0 4px;padding:6px 14px;border:none;' +
    'border-radius:999px;background:#e3e6ea;color:#3c4043;font-size:11px;' +
    'line-height:1;letter-spacing:2px;cursor:pointer;font-family:inherit;';
  marker.parentNode && marker.parentNode.insertBefore(button, marker);
  hidden.forEach(hideElement);
  button.addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    var expanded = button.getAttribute('aria-expanded') === 'true';
    hidden.forEach(function (el) {
      if (expanded) {
        hideElement(el);
      } else {
        el.style.display = el.getAttribute(C.collapsedAttr) || '';
        el.removeAttribute(C.collapsedAttr);
      }
    });
    button.setAttribute('aria-expanded', String(!expanded));
    var label = expanded ? C.show : C.hide;
    button.setAttribute('aria-label', label);
    button.title = label;
    if (window.__rnReport) setTimeout(window.__rnReport, 0);
  });
})();
true;
`;
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * Collapse the trailing ">"-quoted block of a plain-text email.
 *
 * Operates on the ESCAPED html produced by plainTextToSafeHtml (lines are
 * plain text with entities plus <a> tags, still newline-separated). The quote
 * run is wrapped in native <details>/<summary>, which toggles without any
 * script.
 *
 * Collapsed: the last run of "&gt;"-prefixed lines (interior blank lines
 * included). Left visible: everything before it (reply + attribution line),
 * and a trailing "-- " signature block after it. No-op when real content
 * follows the run (bottom-posted/interleaved reply), when there is no content
 * before it, or when there are no quote lines at all.
 */
export function collapsePlainTextQuotes(safeHtml: string, labels: QuoteCollapseLabels): string {
  const lines = safeHtml.split('\n');
  const isQuote = (l: string) => /^\s*&gt;/.test(l);

  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isQuote(lines[i])) { end = i; break; }
  }
  if (end === -1) return safeHtml;

  // Everything after the run must be blank or a "-- " signature block.
  let inSignature = false;
  for (let i = end + 1; i < lines.length; i++) {
    if (inSignature || lines[i].trim() === '') continue;
    if (/^--\s*$/.test(lines[i].trim())) { inSignature = true; continue; }
    return safeHtml;
  }

  // Walk back to the start of the run; blank lines BETWEEN quote lines are
  // part of it (start only ever lands on a quote line).
  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    if (isQuote(lines[i])) start = i;
    else if (lines[i].trim() !== '') break;
  }

  // Never collapse the entire message down to just the toggle.
  if (!lines.slice(0, start).some((l) => l.trim() !== '')) return safeHtml;

  const before = lines.slice(0, start).join('\n');
  const quoted = lines.slice(start, end + 1).join('\n');
  const after = lines.slice(end + 1).join('\n');
  // Same pill look as the HTML-path toggle button; list-style:none hides the
  // native disclosure triangle.
  const summary =
    `<summary title="${escapeAttr(labels.show)}" style="display:inline-block;` +
    'list-style:none;margin:4px 0;padding:6px 14px;border-radius:999px;' +
    'background:#e3e6ea;color:#3c4043;font-size:11px;line-height:1;' +
    'letter-spacing:2px;cursor:pointer;">•••</summary>';
  return `${before}\n<details>${summary}${quoted}</details>${after ? '\n' + after : ''}`;
}
