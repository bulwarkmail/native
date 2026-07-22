import React from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useColors } from '../theme/colors';
import type { ThemePalette } from '../theme/tokens';
import { buildEditorHtml, MIN_EDITOR_HEIGHT } from '../lib/editor-html';

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
  /**
   * Read the live editor DOM content. Resolves with the current innerHTML or
   * rejects after `timeoutMs` when the page script is dead or the bridge is
   * broken — callers must treat that as "content unknown", never fall back to
   * possibly-stale state (issue #9: doing so silently sent blank replies).
   */
  getHtml(timeoutMs?: number): Promise<string>;
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

const RichTextEditor = React.forwardRef<RichTextEditorHandle, Props>(function RichTextEditor(
  { initialHtml = '', placeholder = '', onChange, onSelectionChange, onFocus, onBlur },
  ref,
) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const webViewRef = React.useRef<WebView>(null);
  const [height, setHeight] = React.useState(MIN_EDITOR_HEIGHT);
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

  // Pending getHtml() readbacks, keyed by request id. Timers reject requests
  // the page never answers (dead script / broken bridge).
  const snapshotSeq = React.useRef(0);
  const pendingSnapshots = React.useRef(
    new Map<number, {
      resolve: (html: string) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>(),
  );
  React.useEffect(() => {
    const pending = pendingSnapshots.current;
    return () => {
      for (const { timer, reject } of pending.values()) {
        clearTimeout(timer);
        reject(new Error('Editor unmounted'));
      }
      pending.clear();
    };
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
    getHtml: (timeoutMs = 2000) =>
      new Promise<string>((resolve, reject) => {
        const id = ++snapshotSeq.current;
        const timer = setTimeout(() => {
          pendingSnapshots.current.delete(id);
          reject(new Error('Editor did not answer'));
        }, timeoutMs);
        pendingSnapshots.current.set(id, { resolve, reject, timer });
        call(`window.__rne && window.__rne.getHtml(${id})`);
      }),
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
        if (!Number.isNaN(h) && h > 0) setHeight(Math.max(MIN_EDITOR_HEIGHT, h));
        break;
      }
      case 'htmlSnapshot': {
        const p = data.payload as { id?: number; html?: string } | null;
        const entry = typeof p?.id === 'number' ? pendingSnapshots.current.get(p.id) : undefined;
        if (entry) {
          pendingSnapshots.current.delete(p!.id!);
          clearTimeout(entry.timer);
          entry.resolve(typeof p?.html === 'string' ? p.html : '');
        }
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
