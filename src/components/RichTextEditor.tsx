import React from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useColors } from '../theme/colors';
import type { ThemePalette } from '../theme/tokens';

// Minimum visible editor height (px). The editor auto-grows beyond this as the
// user types, and the parent ScrollView handles overflow.
const MIN_HEIGHT = 220;

export type RichTextCommand =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikeThrough'
  | 'insertUnorderedList'
  | 'insertOrderedList'
  | 'formatBlock:H1'
  | 'formatBlock:H2'
  | 'formatBlock:BLOCKQUOTE'
  | 'formatBlock:P'
  | 'justifyLeft'
  | 'justifyCenter'
  | 'justifyRight'
  | 'removeFormat'
  | 'undo'
  | 'redo';

export interface RichTextSelectionState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeThrough: boolean;
  ul: boolean;
  ol: boolean;
  blockquote: boolean;
  h1: boolean;
  h2: boolean;
  alignLeft: boolean;
  alignCenter: boolean;
  alignRight: boolean;
  link: boolean;
}

const EMPTY_STATE: RichTextSelectionState = {
  bold: false, italic: false, underline: false, strikeThrough: false,
  ul: false, ol: false, blockquote: false, h1: false, h2: false,
  alignLeft: false, alignCenter: false, alignRight: false, link: false,
};

export interface RichTextEditorHandle {
  exec(command: RichTextCommand): void;
  insertLink(url: string, label?: string): void;
  unsetLink(): void;
  insertImage(src: string, cid?: string, alt?: string): void;
  setHtml(html: string): void;
  focus(): void;
}

interface Props {
  initialHtml?: string;
  placeholder?: string;
  onChange?: (html: string) => void;
  onSelectionChange?: (state: RichTextSelectionState) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

function buildEditorHtml(opts: {
  initialHtml: string;
  placeholder: string;
  c: ThemePalette;
}): string {
  const { initialHtml, placeholder, c } = opts;
  // Inject initial content as a JSON-encoded string so any HTML/quotes inside
  // are safely embedded (no template literal collision with the script body).
  const initialJson = JSON.stringify(initialHtml);
  const placeholderJson = JSON.stringify(placeholder);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
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
    min-height: ${MIN_HEIGHT}px;
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
<div id="editor" contenteditable="true" data-placeholder=${placeholderJson}></div>
<script>
(function () {
  var editor = document.getElementById('editor');
  var lastHtml = null;
  var lastHeight = 0;

  function refreshEmpty() {
    var html = editor.innerHTML;
    var isEmpty =
      html === '' ||
      html === '<br>' ||
      html === '<p></p>' ||
      html === '<p><br></p>' ||
      editor.textContent.trim() === '' && editor.querySelectorAll('img').length === 0;
    editor.setAttribute('data-empty', isEmpty ? 'true' : 'false');
  }

  function post(type, payload) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, payload: payload }));
    }
  }

  function reportHeight() {
    var h = Math.max(${MIN_HEIGHT}, editor.scrollHeight + 8);
    if (Math.abs(h - lastHeight) < 2) return;
    lastHeight = h;
    post('height', h);
  }

  function reportChange() {
    refreshEmpty();
    var html = editor.innerHTML;
    if (html === lastHtml) return;
    lastHtml = html;
    post('change', html);
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
    post('selection', state);
  }

  // ── Initial content ────────────────────────────────────────────────
  var initial = ${initialJson};
  if (initial && typeof initial === 'string') editor.innerHTML = initial;
  refreshEmpty();
  lastHtml = editor.innerHTML;

  editor.addEventListener('input', function () {
    reportChange();
    reportHeight();
  });
  editor.addEventListener('blur', function () { post('blur', null); });
  editor.addEventListener('focus', function () { post('focus', null); });
  document.addEventListener('selectionchange', function () {
    if (document.activeElement === editor) reportSelection();
  });

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
      // javascript:/data: link to their recipient.
      var safeSchemeRe = /^(https?:|mailto:|tel:|sms:|\/|\?|#)/i;
      var trimmed = (url || '').trim();
      if (!trimmed || !safeSchemeRe.test(trimmed)) return;
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
    focus: function () { editor.focus(); },
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

const RichTextEditor = React.forwardRef<RichTextEditorHandle, Props>(function RichTextEditor(
  { initialHtml = '', placeholder = '', onChange, onSelectionChange, onFocus, onBlur },
  ref,
) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const webViewRef = React.useRef<WebView>(null);
  const [height, setHeight] = React.useState(MIN_HEIGHT);
  const onChangeRef = React.useRef(onChange);
  const onSelectionRef = React.useRef(onSelectionChange);
  const onFocusRef = React.useRef(onFocus);
  const onBlurRef = React.useRef(onBlur);
  onChangeRef.current = onChange;
  onSelectionRef.current = onSelectionChange;
  onFocusRef.current = onFocus;
  onBlurRef.current = onBlur;

  // Build the source HTML once. Theming changes won't auto-rebuild the page,
  // which is fine: themes change rarely and the user can recompose if needed.
  const html = React.useMemo(
    () => buildEditorHtml({ initialHtml, placeholder, c }),
    // c reference changes per theme switch but we don't want to lose user
    // edits on a theme change. Bake in the initial colors only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const call = React.useCallback((script: string) => {
    webViewRef.current?.injectJavaScript(`${script}; true;`);
  }, []);

  React.useImperativeHandle(ref, () => ({
    exec: (command) => {
      const [name, value] = command.split(':');
      if (value) call(`window.__rne && window.__rne.exec(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
      else call(`window.__rne && window.__rne.exec(${JSON.stringify(name)})`);
    },
    insertLink: (url, label) => {
      call(`window.__rne && window.__rne.insertLink(${JSON.stringify(url)}, ${JSON.stringify(label ?? '')})`);
    },
    unsetLink: () => {
      call(`window.__rne && window.__rne.unsetLink()`);
    },
    insertImage: (src, cid, alt) => {
      call(`window.__rne && window.__rne.insertImage(${JSON.stringify(src)}, ${JSON.stringify(cid ?? '')}, ${JSON.stringify(alt ?? '')})`);
    },
    setHtml: (next) => {
      call(`window.__rne && window.__rne.setHtml(${JSON.stringify(next)})`);
    },
    focus: () => {
      call(`window.__rne && window.__rne.focus()`);
    },
  }), [call]);

  const onMessage = (event: WebViewMessageEvent) => {
    let data: { type: string; payload: unknown };
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    switch (data.type) {
      case 'change':
        onChangeRef.current?.(typeof data.payload === 'string' ? data.payload : '');
        break;
      case 'height': {
        const h = typeof data.payload === 'number' ? data.payload : Number(data.payload);
        if (!Number.isNaN(h) && h > 0) setHeight(Math.max(MIN_HEIGHT, h));
        break;
      }
      case 'selection':
        onSelectionRef.current?.((data.payload as RichTextSelectionState) ?? EMPTY_STATE);
        break;
      case 'focus':
        onFocusRef.current?.();
        break;
      case 'blur':
        onBlurRef.current?.();
        break;
    }
  };

  return (
    <View style={[styles.container, { height }]}>
      <WebView
        ref={webViewRef}
        originWhitelist={['about:blank']}
        source={{ html }}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled={false}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        setSupportMultipleWindows={false}
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        allowsBackForwardNavigationGestures={false}
        incognito
        cacheEnabled={false}
        mixedContentMode="never"
        androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
        style={styles.webview}
        containerStyle={styles.webviewContainer}
        onShouldStartLoadWithRequest={(request) => {
          // Allow only the initial about:blank doc + data URIs we emit
          // ourselves. Reject `about:*` (e.g. about:srcdoc) and every other
          // scheme so a paste-injected anchor can't navigate the editor.
          const url = request.url;
          return !url || url === 'about:blank' || url.startsWith('data:');
        }}
      />
    </View>
  );
});

export default RichTextEditor;

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: {
      width: '100%',
      backgroundColor: c.background,
    },
    webview: {
      backgroundColor: 'transparent',
      flex: 1,
    },
    webviewContainer: {
      backgroundColor: 'transparent',
    },
  });
}
