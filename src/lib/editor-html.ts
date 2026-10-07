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
import { PLAIN_PASTE_MAX_CHARS } from './plain-text-paste';

// Minimum visible editor height (px). The editor auto-grows beyond this as the
// user types, and the parent ScrollView handles overflow.
export const MIN_EDITOR_HEIGHT = 220;

// Shortest gap between two `change` posts while typing (see the page script).
// Readers that need the current body - send, save, format switch - ask the
// page with `getHtml` instead of waiting for the next post.
export const CHANGE_THROTTLE_MS = 400;

// How long a plain-text list paste waits for RN to send back its HTML
// (`__rne.insertPasted`) before the page pastes the text as it is.
export const PASTE_FALLBACK_MS = 1500;

/**
 * The editor page's Content-Security-Policy, mirroring the viewer's
 * (`src/lib/email-html.ts`). Nothing but images, styles and our own inline
 * script may load. With `blockRemoteImages` images and fonts are limited to
 * what the composer produces itself - `data:` (inline and hydrated `cid:`
 * images) and `blob:` (pasted images) - so a quoted original's tracking
 * pixels and remote images don't fire just because it is replied to.
 */
export function buildEditorCsp(blockRemoteImages: boolean): string {
  const resources = blockRemoteImages
    ? ['img-src data: blob:', 'font-src data:', "media-src 'none'"]
    : ['img-src data: blob: https: http:', 'font-src data: https: http:', 'media-src data: https: http:'];
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
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

export function buildEditorHtml(opts: {
  initialHtml: string;
  placeholder: string;
  c: ThemePalette;
  /** Block remote images and fonts (see `buildEditorCsp`). */
  blockRemoteImages?: boolean;
}): string {
  const { initialHtml, placeholder, c, blockRemoteImages = false } = opts;
  // Inject initial content as a JSON-encoded string so any HTML/quotes inside
  // are safely embedded (no template literal collision with the script body).
  const initialJson = JSON.stringify(initialHtml);
  const placeholderJson = JSON.stringify(placeholder);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${buildEditorCsp(blockRemoteImages)}" />
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
</style>
</head>
<body>
<div id="editor" contenteditable="true" dir="auto" data-placeholder=${placeholderJson}></div>
<script>
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
  // A plain-text list paste waiting for RN: { id, text, range, timer }.
  var pendingPaste = null;
  var pasteSeq = 0;

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

  // ── Initial content ────────────────────────────────────────────────
  var initial = ${initialJson};
  if (initial && typeof initial === 'string') editor.innerHTML = initial;
  refreshEmpty();
  lastHtml = editor.innerHTML;

  editor.addEventListener('input', function () {
    scheduleChange();
    reportHeight();
    updateMention();
  });
  editor.addEventListener('blur', function () {
    flushChange();
    endMention();
    post('blur', null);
  });
  editor.addEventListener('focus', function () { post('focus', null); });
  document.addEventListener('selectionchange', function () {
    if (document.activeElement !== editor) return;
    reportSelection();
    updateMention();
  });

  // ── Plain-text list paste ──────────────────────────────────────────
  // RN turns a pasted "- " / "1. " list into a real list (plain-text-paste.ts)
  // and sends the HTML back to insertPasted. Only the cheap check lives here,
  // written with char codes because regex escapes would be cooked away (see
  // the header): does a line start, after spaces or tabs, with "-", "*", "•"
  // or 1-3 digits and "." or ")", then a space or tab and some text?
  var PLAIN_PASTE_MAX_CHARS = ${PLAIN_PASTE_MAX_CHARS};
  var PASTE_FALLBACK_MS = ${PASTE_FALLBACK_MS};
  function isGap(code) { return code === 32 || code === 9; }
  function isLineEnd(code) { return code === 10 || code === 13; }
  // The whitespace the parser's regex counts as space: an item needs some
  // other character after its marker.
  function isSpace(code) {
    return (code >= 9 && code <= 13) || code === 32 || code === 160 || code === 5760
      || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 || code === 8239
      || code === 8287 || code === 12288 || code === 65279;
  }
  function hasListLine(text) {
    var i = 0;
    var n = text.length;
    while (i < n) {
      while (i < n && isGap(text.charCodeAt(i))) i++;
      var code = text.charCodeAt(i);
      var marker = code === 45 || code === 42 || code === 8226;
      if (marker) {
        i++;
      } else {
        var digits = 0;
        while (digits < 4 && i < n && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) { i++; digits++; }
        code = text.charCodeAt(i);
        marker = digits >= 1 && digits <= 3 && (code === 46 || code === 41);
        if (marker) i++;
      }
      if (marker && isGap(text.charCodeAt(i))) {
        while (i < n && isGap(text.charCodeAt(i))) i++;
        if (i < n && !isSpace(text.charCodeAt(i))) return true;
      }
      while (i < n && !isLineEnd(text.charCodeAt(i))) i++;
      i++;
    }
    return false;
  }

  // Puts the caret back where the paste happened. If the user moved it while
  // RN worked, the paste still lands at the saved spot. The saved range is
  // live, but text typed at that spot meanwhile doesn't move its start, so
  // the typed text ends up after the paste.
  function restoreRange(range) {
    var sel = window.getSelection();
    if (!range || !sel || !editor.contains(range.startContainer)) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function settlePaste(html) {
    var paste = pendingPaste;
    pendingPaste = null;
    clearTimeout(paste.timer);
    // execCommand only edits the focused editor, and the answer (or the
    // fallback timer) can arrive after the user left it.
    editor.focus();
    restoreRange(paste.range);
    try {
      if (html) document.execCommand('insertHTML', false, html);
      else document.execCommand('insertText', false, paste.text);
    } catch (e) {}
    reportChange();
    reportHeight();
    reportSelection();
  }

  editor.addEventListener('paste', function (e) {
    var data = e.clipboardData;
    if (!data) return;
    // Copied rich content keeps the WebView's own paste.
    if (data.getData('text/html')) return;
    var text = data.getData('text/plain');
    if (!text || text.length > PLAIN_PASTE_MAX_CHARS || !hasListLine(text)) return;
    if (pendingPaste) settlePaste(null);
    var sel = window.getSelection();
    var range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    e.preventDefault();
    // A dead bridge must not swallow the paste.
    var id = ++pasteSeq;
    pendingPaste = { id: id, text: text, range: range, timer: setTimeout(function () { settlePaste(null); }, PASTE_FALLBACK_MS) };
    post('pastePlain', { id: id, text: text });
  });

  // ── @-mention of a recipient ───────────────────────────────────────
  // While the caret ends an "@query" run the page posts 'mention' with the
  // query, and null once it ends; RN offers the matching recipients and
  // calls insertMention with the chosen label. The "@" counts only at the
  // start of a word (after a space or NBSP, or at the start of its block),
  // so info@example.com never triggers, and never in code or a link.
  // The open run: { node, start, end, query }, start at the "@". A blur
  // posts null but keeps it, because a tap on RN's list can blur the editor
  // before the pick arrives; insertMention re-checks it against the DOM.
  var mention = null;
  var postedMention = null;

  function mentionAllowedIn(node) {
    for (var p = node.parentNode; p; p = p.parentNode) {
      if (p === editor) return true;
      if (p.nodeType === 1 && (p.tagName === 'PRE' || p.tagName === 'CODE' || p.tagName === 'A')) return false;
    }
    return false;
  }

  // Elements that end a word: blocks, line breaks and images.
  var WORD_BREAK_TAGS = ' P DIV LI UL OL BLOCKQUOTE H1 H2 H3 H4 H5 H6 PRE TABLE TBODY THEAD TR TD TH BR HR IMG ';
  function breaksWord(el) { return WORD_BREAK_TAGS.indexOf(' ' + el.tagName + ' ') !== -1; }

  // The last character of the text before 'node' in the same block (a space
  // when there is none), so "info" + "<b>@x</b>" reads as one word.
  function charBefore(node) {
    var n = node;
    for (;;) {
      while (!n.previousSibling) {
        n = n.parentNode;
        if (!n || n === editor || (n.nodeType === 1 && breaksWord(n))) return 32;
      }
      n = n.previousSibling;
      for (;;) {
        if (n.nodeType === 3) {
          if (n.data.length) return n.data.charCodeAt(n.data.length - 1);
          break;
        }
        if (n.nodeType !== 1) break;
        if (breaksWord(n)) return 32;
        if (!n.lastChild) break;
        n = n.lastChild;
      }
    }
  }

  // The "@query" run in text node 'node' that ends at 'end', or null.
  function mentionRunAt(node, end) {
    if (!node || node.nodeType !== 3 || !mentionAllowedIn(node)) return null;
    var data = node.data;
    if (end > data.length) return null;
    for (var i = end - 1; i >= 0; i--) {
      var code = data.charCodeAt(i);
      if (code === 64) {
        var prev = i > 0 ? data.charCodeAt(i - 1) : charBefore(node);
        if (prev !== 32 && prev !== 160) return null;
        return { node: node, start: i, end: end, query: data.slice(i + 1, end) };
      }
      if (isSpace(code)) return null;
    }
    return null;
  }

  function findMention() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    return mentionRunAt(range.startContainer, range.startOffset);
  }

  function updateMention() {
    mention = findMention();
    var query = mention ? mention.query : null;
    if (query === postedMention) return;
    postedMention = query;
    post('mention', query === null ? null : { query: query });
  }

  function endMention() {
    if (postedMention === null) return;
    postedMention = null;
    post('mention', null);
  }

  function placeCaret(sel, node, offset) {
    var caret = document.createRange();
    caret.setStart(node, offset);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
  }

  // ── Bridge: receive commands from RN ───────────────────────────────
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
      var safeAlt = (alt || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      var safeCid = cid ? cid.replace(/"/g, '&quot;') : '';
      var html = '<img src="' + safeSrc + '" alt="' + safeAlt + '"' +
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
    // Replaces the open "@query" run with "@label " as text - never as HTML,
    // since the label comes from recipients' display names, which a reply
    // takes from the incoming message. The run is checked again first: the
    // user may have typed on while RN picked the label.
    insertMention: function (label) {
      var m = mention;
      var run = m && editor.contains(m.node) ? mentionRunAt(m.node, m.end) : null;
      if (!run || run.start !== m.start) {
        mention = null;
        return;
      }
      if (typeof label !== 'string' || !label) return;
      var node = run.node;
      var spaceFollows = run.end < node.data.length && isSpace(node.data.charCodeAt(run.end));
      var text = '@' + label + (spaceFollows ? '' : ' ');
      editor.focus();
      var sel = window.getSelection();
      var range = document.createRange();
      range.setStart(node, run.start);
      range.setEnd(node, run.end);
      sel.removeAllRanges();
      sel.addRange(range);
      // insertText keeps the edit undoable; where it fails, write the text
      // node directly.
      var inserted = false;
      try { inserted = document.execCommand('insertText', false, text); } catch (e) {}
      if (inserted && spaceFollows) {
        // Past the space that was already there, ready for the next word.
        if (sel.modify) {
          sel.modify('move', 'forward', 'character');
        } else if (sel.rangeCount) {
          var at = sel.getRangeAt(0);
          var atNode = at.startContainer;
          if (atNode.nodeType === 3 && at.startOffset < atNode.data.length) placeCaret(sel, atNode, at.startOffset + 1);
        }
      } else if (!inserted) {
        var data = node.data;
        node.data = data.slice(0, run.start) + text + data.slice(run.end);
        placeCaret(sel, node, run.start + text.length + (spaceFollows ? 1 : 0));
      }
      updateMention();
      reportChange();
      reportHeight();
      reportSelection();
    },
    // RN's answer to 'pastePlain' with that paste's id: the list HTML, or
    // null to paste the text as text. An answer for a paste no longer waiting
    // (it timed out, or a newer paste replaced it) is dropped.
    insertPasted: function (html, id) {
      if (!pendingPaste || pendingPaste.id !== id) return;
      settlePaste(html);
    },
  };

  reportHeight();
  reportChange();

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
