// Builds the self-contained HTML document for the RichTextEditor WebView.
// Kept as a pure module (no react-native imports) so tests can assert the
// embedded page script stays syntactically valid JavaScript.
//
// IMPORTANT: the page script lives inside a JS template literal. Backslash
// escapes are "cooked" by the template (`\/` becomes `/`, `\s` becomes `s`),
// which once shipped an invalid regex that killed the whole inline script
// with a SyntaxError (issue #11 — Send stayed disabled because the editor
// never posted `change` messages). Never rely on a backslash reaching the
// page verbatim; write escape-free code or double the backslash.

import type { ThemePalette } from '../theme/tokens';
import { randomHex } from './random';

// Minimum visible editor height (px). The editor auto-grows beyond this as the
// user types, and the parent ScrollView handles overflow.
export const MIN_EDITOR_HEIGHT = 220;

// Shortest gap between two `change` posts while typing (see the page script).
// Readers that need the current body - send, save, format switch - ask the
// page with `getHtml` instead of waiting for the next post.
export const CHANGE_THROTTLE_MS = 400;

// Room above a reply's quote for its "•••" toggle (px).
const QUOTE_TOGGLE_SPACE = 30;

/**
 * The editor page's Content-Security-Policy, mirroring the viewer's
 * (`src/lib/email-html.ts`). Nothing but images, styles and our own inline
 * script may load. With `blockRemoteImages` images and fonts are limited to
 * what the composer produces itself - `data:` (inline and hydrated `cid:`
 * images) and `blob:` (pasted images) - so a quoted original's tracking
 * pixels and remote images don't fire just because it is replied to.
 *
 * Scripts need the page's `nonce`: the editor's own script carries it, and
 * inline handlers in seeded or pasted HTML (a quoted `<img onerror=…>`)
 * don't run. Commands from the app arrive through injectJavaScript, which
 * page CSP doesn't govern.
 */
export function buildEditorCsp(blockRemoteImages: boolean, nonce?: string): string {
  const resources = blockRemoteImages
    ? ['img-src data: blob:', 'font-src data:', "media-src 'none'"]
    : ['img-src data: blob: https: http:', 'font-src data: https: http:', 'media-src data: https: http:'];
  return [
    "default-src 'none'",
    nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    "style-src 'unsafe-inline'",
    ...resources,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Whether the composer must open the editor with remote images blocked: it
 * is seeded with someone else's HTML (the quoted original of a reply or
 * forward, or a reopened draft that carries a quote) and the viewer would
 * have shown that message with its remote content blocked too. A reopened
 * draft doesn't say whose message it quotes, so its quote counts as
 * untrusted.
 */
export function shouldBlockEditorRemoteImages(opts: {
  /** The HTML the editor is seeded with from a message, if any. */
  seedHtml?: string | null;
  isDraft: boolean;
  externalContentPolicy: 'allow' | 'block' | 'ask';
  /** The quoted message's sender is trusted (ignored for drafts). */
  senderTrusted: boolean;
}): boolean {
  const { seedHtml, isDraft, externalContentPolicy, senderTrusted } = opts;
  if (!seedHtml || externalContentPolicy === 'allow') return false;
  if (isDraft) return /\sdata-quoted-html=|<blockquote\b/i.test(seedHtml);
  return !senderTrusted;
}

/**
 * Page-script function for a tap on the empty space under the editor: focus
 * it with the caret where the user's own text goes, in front of the
 * signature or the quoted message, else at the end. A string, embedded in
 * the page script and run by the unit test against stand-in DOM objects.
 */
export const FOCUS_END_SOURCE = `function focusEnd(editor) {
    editor.focus();
    var sel = window.getSelection();
    if (!sel) return;
    var stop = editor.querySelector('[data-signature-block="start"], [data-signature-block="separator"], [data-quoted-html]');
    var range = document.createRange();
    var prev = stop ? stop.previousElementSibling : null;
    if (prev) {
      range.selectNodeContents(prev);
      range.collapse(false);
    } else if (stop) {
      range.setStartBefore(stop);
      range.collapse(true);
    } else {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }`;

/**
 * Whether the editor WebView may load `url`: only its initial about:blank
 * document (`source={{ html }}` loads as about:blank on both platforms, as
 * in the reader). Every other URL, `about:srcdoc` and `data:` included, is
 * refused: a `data:text/html` page reached through a refresh meta or a
 * pasted link would replace the editor with a document of the sender's.
 */
export function isEditorNavigationAllowed(url: string | undefined): boolean {
  return !url || url === 'about:blank';
}

/**
 * JSON for a value written into an inline `<script>`. The HTML tokenizer
 * ends the script at the first `</script` whatever the JS around it, so a
 * quoted original carrying one (inside a kept `<style>`, say) used to close
 * the editor's script early and run as markup. `<` is written as `<`;
 * U+2028/2029 are escaped too, for engines that read them as line ends.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildEditorHtml(opts: {
  initialHtml: string;
  placeholder: string;
  c: ThemePalette;
  /** Block remote images and fonts (see `buildEditorCsp`). */
  blockRemoteImages?: boolean;
  /**
   * Keep the page's visual viewport at the top and report every pan to RN as
   * a `viewportShift` (CSS px = dp) instead (see the page script). Android
   * only: its WebView pans the visual viewport to reveal the caret.
   */
  pinVisualViewport?: boolean;
  /**
   * A reply: the quoted original (the top-level `data-quoted-html` block,
   * attribution included) starts hidden behind a "•••" toggle (webmail
   * reply-quote-collapse, #1405). Hiding is styling on the editor element
   * only, so the quote stays in the body that is saved and sent.
   */
  collapseQuote?: boolean;
  /** The toggle's accessible names. */
  quoteToggleLabels?: { show: string; hide: string };
}): string {
  const { initialHtml, placeholder, c, blockRemoteImages = false, pinVisualViewport = false, collapseQuote = false } = opts;
  const quoteLabels = opts.quoteToggleLabels ?? { show: 'Show quoted text', hide: 'Hide quoted text' };
  // Inject initial content as a JSON-encoded string so any HTML/quotes inside
  // are safely embedded (no template literal collision with the script body,
  // and no `</script` that ends the script, see jsonForScript).
  const initialJson = jsonForScript(initialHtml);
  const nonce = randomHex(16);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${buildEditorCsp(blockRemoteImages, nonce)}" />
<meta name="referrer" content="no-referrer" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; background: ${c.background}; color: ${c.text}; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 16px;
    line-height: 1.5;
    overflow-y: hidden;
    -webkit-text-size-adjust: 100%;
  }
  #editor {
    outline: none;
    padding: 12px 16px 24px;
    min-height: ${MIN_EDITOR_HEIGHT}px;
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  #editor[data-empty="true"]::before {
    content: attr(data-placeholder);
    color: ${c.textMuted};
    pointer-events: none;
    position: absolute;
  }
  #editor p { margin: 0 0 12px 0; }
  #editor p:last-child { margin-bottom: 0; }
  #editor h1 { font-size: 1.4em; font-weight: 700; margin: 0 0 12px 0; line-height: 1.2; }
  #editor h2 { font-size: 1.2em; font-weight: 700; margin: 0 0 10px 0; line-height: 1.3; }
  #editor ul, #editor ol { margin: 0 0 12px 0; padding-left: 24px; }
  #editor li { margin-bottom: 4px; }
  #editor blockquote {
    margin: 0 0 12px 0;
    padding: 4px 0 4px 12px;
    border-left: 3px solid ${c.border};
    color: ${c.textSecondary};
  }
  #editor a { color: ${c.primary}; text-decoration: underline; }
  #editor img { max-width: 100%; height: auto; border-radius: 4px; }
  #editor pre, #editor code {
    background: ${c.surfaceActive};
    border-radius: 4px;
    padding: 2px 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.92em;
  }
  #editor pre { padding: 8px 12px; overflow-x: auto; }
  ::selection { background: ${c.primary}33; }
  body { position: relative; }
  #editor.rne-quote-toggle > [data-quoted-html] { padding-top: ${QUOTE_TOGGLE_SPACE}px; }
  #editor.rne-quote-collapsed > [data-quoted-html] { height: ${QUOTE_TOGGLE_SPACE}px; overflow: hidden; }
  #rne-quote-toggle {
    position: absolute;
    display: none;
    margin: 0;
    padding: 0 12px;
    height: 22px;
    line-height: 22px;
    border: none;
    border-radius: 999px;
    background: ${c.surfaceActive};
    color: ${c.textMuted};
    font-size: 11px;
    letter-spacing: 2px;
  }
</style>
</head>
<body>
<div id="editor" contenteditable="true" dir="auto" data-placeholder="${escapeAttr(placeholder)}"></div>
<script nonce="${nonce}">
(function () {
  var editor = document.getElementById('editor');
  var lastHtml = null;
  var lastHeight = 0;
  var lastSelection = '';
  // Every 'change' re-renders the whole composer, so typing posts at most
  // one per window: the first keystroke at once (the composer learns it is
  // dirty), then the latest content when the window ends. Commands, blur
  // and setHtml post straight away.
  var CHANGE_THROTTLE_MS = ${CHANGE_THROTTLE_MS};
  var lastChangeAt = 0;
  var changeTimer = null;

  // Checked on every keystroke, so it avoids serializing innerHTML.
  function refreshEmpty() {
    var isEmpty = editor.textContent.trim() === '' && !editor.querySelector('img');
    editor.setAttribute('data-empty', isEmpty ? 'true' : 'false');
  }

  function post(type, payload) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, payload: payload }));
    }
  }

  function reportHeight() {
    placeQuoteToggle();
    var h = Math.max(${MIN_EDITOR_HEIGHT}, editor.scrollHeight + 8);
    if (Math.abs(h - lastHeight) < 2) return;
    lastHeight = h;
    post('height', h);
  }

  function reportChange() {
    if (changeTimer) {
      clearTimeout(changeTimer);
      changeTimer = null;
    }
    refreshEmpty();
    var html = editor.innerHTML;
    if (html === lastHtml) return;
    lastHtml = html;
    lastChangeAt = Date.now();
    post('change', html);
  }

  function scheduleChange() {
    refreshEmpty();
    if (changeTimer) return;
    var wait = CHANGE_THROTTLE_MS - (Date.now() - lastChangeAt);
    if (wait <= 0) {
      reportChange();
      return;
    }
    changeTimer = setTimeout(function () {
      changeTimer = null;
      reportChange();
    }, wait);
  }

  function flushChange() {
    if (changeTimer) reportChange();
  }

  function reportSelection() {
    function active(name) {
      try { return document.queryCommandState(name); } catch (e) { return false; }
    }
    function inBlock(tag) {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return false;
      var node = sel.anchorNode;
      while (node && node !== editor) {
        if (node.nodeType === 1 && node.tagName === tag) return true;
        node = node.parentNode;
      }
      return false;
    }
    var state = {
      bold: active('bold'),
      italic: active('italic'),
      underline: active('underline'),
      strikeThrough: active('strikeThrough'),
      ul: active('insertUnorderedList'),
      ol: active('insertOrderedList'),
      blockquote: inBlock('BLOCKQUOTE'),
      h1: inBlock('H1'),
      h2: inBlock('H2'),
      alignLeft: active('justifyLeft'),
      alignCenter: active('justifyCenter'),
      alignRight: active('justifyRight'),
      link: inBlock('A'),
    };
    // The caret moves on every keystroke; only a change of the formatting
    // state is worth a message (and a composer re-render).
    var key = JSON.stringify(state);
    if (key === lastSelection) return;
    lastSelection = key;
    post('selection', state);
  }

  // ── Collapsed reply quote ──────────────────────────────────────────
  // The toggle lives outside the editable element, over the top of the
  // quote, so it never becomes part of the message.
  var COLLAPSE_QUOTE = ${collapseQuote ? 'true' : 'false'};
  var QUOTE_LABELS = ${jsonForScript(quoteLabels)};
  var quoteToggle = null;

  function topQuote() {
    var node = editor.firstElementChild;
    while (node) {
      if (node.hasAttribute && node.hasAttribute('data-quoted-html')) return node;
      node = node.nextElementSibling;
    }
    return null;
  }

  function quoteCollapsed() {
    return !!quoteToggle && editor.classList.contains('rne-quote-collapsed');
  }

  function placeQuoteToggle() {
    if (!quoteToggle) return;
    var quote = topQuote();
    if (!quote) {
      quoteToggle.style.display = 'none';
      editor.classList.remove('rne-quote-collapsed');
      return;
    }
    quoteToggle.style.display = 'block';
    quoteToggle.style.top = (quote.offsetTop + 4) + 'px';
    quoteToggle.style.left = quote.offsetLeft + 'px';
  }

  function setQuoteCollapsed(collapsed) {
    if (!quoteToggle) return;
    if (collapsed) editor.classList.add('rne-quote-collapsed');
    else editor.classList.remove('rne-quote-collapsed');
    var label = collapsed ? QUOTE_LABELS.show : QUOTE_LABELS.hide;
    quoteToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    quoteToggle.setAttribute('aria-label', label);
    quoteToggle.title = label;
    reportHeight();
  }

  // The caret never stays inside hidden text: moving it there shows the quote.
  function revealQuoteAtCaret() {
    if (!quoteCollapsed()) return;
    var quote = topQuote();
    var sel = window.getSelection();
    if (!quote || !sel || !sel.rangeCount) return;
    var node = sel.anchorNode;
    while (node && node !== editor) {
      if (node === quote) {
        setQuoteCollapsed(false);
        return;
      }
      node = node.parentNode;
    }
  }

  // ── Initial content ────────────────────────────────────────────────
  var initial = ${initialJson};
  if (initial && typeof initial === 'string') editor.innerHTML = initial;
  refreshEmpty();
  lastHtml = editor.innerHTML;

  if (COLLAPSE_QUOTE && topQuote()) {
    quoteToggle = document.createElement('button');
    quoteToggle.id = 'rne-quote-toggle';
    quoteToggle.type = 'button';
    quoteToggle.textContent = '•••';
    // Keep the caret and the keyboard where they are.
    quoteToggle.addEventListener('mousedown', function (e) { e.preventDefault(); });
    quoteToggle.addEventListener('click', function (e) {
      e.preventDefault();
      setQuoteCollapsed(!quoteCollapsed());
    });
    document.body.appendChild(quoteToggle);
    editor.classList.add('rne-quote-toggle');
    setQuoteCollapsed(true);
  }

  editor.addEventListener('input', function () {
    scheduleChange();
    reportHeight();
  });
  editor.addEventListener('blur', function () {
    flushChange();
    post('blur', null);
  });
  editor.addEventListener('focus', function () { post('focus', null); });
  document.addEventListener('selectionchange', function () {
    if (document.activeElement === editor) {
      revealQuoteAtCaret();
      reportSelection();
    }
  });

  // ── Bridge: receive commands from RN ───────────────────────────────
  ${FOCUS_END_SOURCE}

  window.__rne = {
    exec: function (command, value) {
      editor.focus();
      try {
        if (command === 'formatBlock' && value) {
          // Toggle: if we're already in that block, switch to <p>.
          var sel = window.getSelection();
          if (sel && sel.rangeCount) {
            var node = sel.anchorNode;
            while (node && node !== editor) {
              if (node.nodeType === 1 && node.tagName === value.toUpperCase()) {
                document.execCommand('formatBlock', false, '<p>');
                reportChange();
                reportHeight();
                reportSelection();
                return;
              }
              node = node.parentNode;
            }
          }
          document.execCommand('formatBlock', false, '<' + value.toLowerCase() + '>');
        } else {
          document.execCommand(command, false, value);
        }
      } catch (e) {}
      reportChange();
      reportHeight();
      reportSelection();
    },
    setHtml: function (html) {
      editor.innerHTML = html || '';
      lastHtml = editor.innerHTML;
      refreshEmpty();
      reportChange();
      reportHeight();
    },
    insertHtml: function (html) {
      editor.focus();
      try { document.execCommand('insertHTML', false, html); } catch (e) {}
      reportChange();
      reportHeight();
    },
    insertLink: function (url, label) {
      editor.focus();
      // Reject anything that isn't a safe scheme or an absolute path, so the
      // user can't accidentally (or via a malicious paste) ship a
      // javascript:/data: link to their recipient. Written without regex
      // backslash escapes — see the template-cooking warning at the top.
      var trimmed = (url || '').trim();
      var first = trimmed.charAt(0);
      var safeScheme = /^(https?:|mailto:|tel:|sms:)/i.test(trimmed)
        || first === '/' || first === '?' || first === '#';
      if (!trimmed || !safeScheme) return;
      var sel = window.getSelection();
      var hasSelection = sel && sel.rangeCount && !sel.getRangeAt(0).collapsed;
      if (hasSelection) {
        try { document.execCommand('createLink', false, trimmed); } catch (e) {}
        // execCommand doesn't set rel; tag every anchor that points at this URL.
        Array.prototype.forEach.call(editor.getElementsByTagName('a'), function (a) {
          if (a.getAttribute('href') === trimmed) {
            a.setAttribute('rel', 'noopener noreferrer nofollow');
          }
        });
      } else {
        var text = label && label.trim() ? label : trimmed;
        var safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        var safeUrl = trimmed
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        var html = '<a href="' + safeUrl + '" rel="noopener noreferrer nofollow">' + safe + '</a>';
        try { document.execCommand('insertHTML', false, html); } catch (e) {}
      }
      reportChange();
      reportHeight();
      reportSelection();
    },
    unsetLink: function () {
      editor.focus();
      try { document.execCommand('unlink', false, null); } catch (e) {}
      reportChange();
      reportSelection();
    },
    insertImage: function (src, cid, alt) {
      editor.focus();
      var safeSrc = (src || '').replace(/"/g, '&quot;');
      // No alt attribute at all until the user describes the image: alt=""
      // would mark it decorative, and the file name tells nobody anything.
      var safeAlt = typeof alt === 'string' ? alt.replace(/&/g, '&amp;').replace(/"/g, '&quot;') : null;
      var safeCid = cid ? cid.replace(/"/g, '&quot;') : '';
      var html = '<img src="' + safeSrc + '"' + (safeAlt === null ? '' : ' alt="' + safeAlt + '"') +
        (safeCid ? ' data-cid="' + safeCid + '"' : '') + ' />';
      try { document.execCommand('insertHTML', false, html); } catch (e) {}
      reportChange();
      reportHeight();
    },
    // Send-time readback (issue #9): RN asks for the live DOM content instead
    // of trusting the last change message, which can lag typing or be lost
    // entirely if the bridge breaks. The id lets RN match reply to request.
    getHtml: function (id) {
      post('htmlSnapshot', { id: id, html: editor.innerHTML });
    },
    focus: function () { editor.focus(); },
    focusEnd: function () { focusEnd(editor); },
    // The description of the inline image with this cid; "" is decorative.
    setImageAlt: function (cid, alt) {
      var images = editor.getElementsByTagName('img');
      for (var i = 0; i < images.length; i++) {
        if (images[i].getAttribute('data-cid') === cid) images[i].setAttribute('alt', alt);
      }
      reportChange();
    },
  };

  reportHeight();
  reportChange();

  // ── Visual viewport pinning (Android) ──────────────────────────────
  // The WebView is as tall as its content and sits in RN's ScrollView, so
  // the page itself never scrolls. But Android's WebView shrinks the visual
  // viewport to the part of the view that is on screen (above the keyboard,
  // below the header fields) and pans it to reveal the caret while typing.
  // The pan outlives the moment: once the composer is scrolled back to the
  // top the body is still drawn shifted up by that offset, so its first
  // lines hide under To/Cc/Subject until a scroll to the very bottom clamps
  // it away. Undo every pan at once (window.scrollTo only moves the layout
  // viewport; scrolling the top of the page into view resets both) and hand
  // the offset to RN, which scrolls the composer by as much so the caret
  // stays where the pan had put it.
  if (${pinVisualViewport ? 'true' : 'false'} && window.visualViewport) {
    window.visualViewport.addEventListener('scroll', function () {
      var shift = window.visualViewport.offsetTop;
      if (Math.abs(shift) < 0.5) return;
      try { editor.scrollIntoView({ block: 'start', inline: 'nearest' }); } catch (e) {}
      post('viewportShift', shift);
    });
  }

  // Re-measure after async layout (image loads, font swap).
  window.addEventListener('load', function () {
    setTimeout(reportHeight, 50);
    setTimeout(reportHeight, 200);
    setTimeout(reportHeight, 600);
  });
  if (window.ResizeObserver) {
    new ResizeObserver(reportHeight).observe(editor);
  }
})();
true;
</script>
</body>
</html>`;
}
