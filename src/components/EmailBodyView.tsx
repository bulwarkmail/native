import React from 'react';
import { View, StyleSheet, Linking, Platform, Text, Pressable } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Image as ImageIcon, ShieldCheck } from 'lucide-react-native';
import type { Email } from '../api/types';
import { wrapEmailHtml, wrapPlainTextEmail, plainTextToSafeHtml, extractCidRefs, hasRemoteContent, hasMeaningfulHtmlBody } from '../lib/email-html';
import { jmapClient } from '../api/jmap-client';
import { useSettingsStore } from '../stores/settings-store';
import { colors, spacing, typography } from '../theme/tokens';

// Largest inline image we'll pull inline as a data: URI. Anything bigger gets
// skipped so we don't freeze the JS thread base64-encoding megabytes.
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return global.btoa ? global.btoa(binary) : btoa(binary);
}

interface EmailBodyViewProps {
  email: Email;
  senderEmail?: string;
}

function extractHtmlBody(email: Email): string | null {
  for (const part of email.htmlBody ?? []) {
    const v = part.partId ? email.bodyValues?.[part.partId]?.value : undefined;
    if (v) return v;
  }
  return null;
}

function extractTextBody(email: Email): string | null {
  for (const part of email.textBody ?? []) {
    const v = part.partId ? email.bodyValues?.[part.partId]?.value : undefined;
    if (v) return v;
  }
  return null;
}

const HEIGHT_REPORTER = `
(function () {
  // One-time: wrap body contents in a block-level div we can measure reliably.
  // body.scrollHeight on Android WebView is pinned to the container viewport
  // height, so we can't trust it. A dedicated wrapper gives a deterministic
  // bounding box.
  function ensureWrapper() {
    var b = document.body;
    if (!b) return null;
    var wrap = document.getElementById('__rn_email_body_wrap__');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = '__rn_email_body_wrap__';
      wrap.style.display = 'block';
      wrap.style.width = '100%';
      while (b.firstChild) wrap.appendChild(b.firstChild);
      b.appendChild(wrap);
    }
    return wrap;
  }
  function measure() {
    var w = ensureWrapper();
    if (!w) return 0;
    var r = w.getBoundingClientRect();
    var b = document.body;
    var cs = window.getComputedStyle(b);
    var padTop = parseFloat(cs.paddingTop) || 0;
    var padBottom = parseFloat(cs.paddingBottom) || 0;
    // r.height is the wrapper's own content-box height.
    // r.top already includes body's padding-top (rects are viewport-relative),
    // so we only need to add padding-bottom + padding-top once.
    return Math.ceil(r.height + padTop + padBottom);
  }
  function report() {
    try {
      var h = measure();
      if (h > 0 && window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(String(h + 8));
      }
    } catch (e) {}
  }
  // Measure only after layout has settled: two animation frames ensures style
  // recalc + layout + paint are complete, and fonts.ready waits for webfont
  // metrics to apply (text wraps can differ significantly before fonts load).
  function reportWhenReady() {
    var go = function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(report);
      });
    };
    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(go).catch(go);
    } else {
      go();
    }
  }
  function scheduleReports() {
    reportWhenReady();
    // Follow-up re-measures: late-arriving images / async layout shifts.
    [120, 300, 700, 1500, 3000].forEach(function (t) { setTimeout(report, t); });
  }
  if (document.readyState === 'complete') scheduleReports();
  else {
    window.addEventListener('load', scheduleReports);
    document.addEventListener('DOMContentLoaded', reportWhenReady);
  }
  try {
    var ro = new ResizeObserver(report);
    if (document.documentElement) ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  } catch (e) {}
  try {
    var mo = new MutationObserver(report);
    if (document.body) mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  } catch (e) {}
  try {
    Array.prototype.forEach.call(document.images || [], function (img) {
      if (!img.complete) img.addEventListener('load', report);
      img.addEventListener('error', report);
    });
  } catch (e) {}
  true;
})();
`;

export default function EmailBodyView({ email, senderEmail }: EmailBodyViewProps) {
  const externalContentPolicy = useSettingsStore((s) => s.externalContentPolicy);
  const isSenderTrusted = useSettingsStore((s) => s.isSenderTrusted);
  const addTrustedSender = useSettingsStore((s) => s.addTrustedSender);

  const html = React.useMemo(() => extractHtmlBody(email), [email]);
  const text = React.useMemo(() => extractTextBody(email), [email]);
  // Prefer textBody when the HTML is a minimal auto-generated wrapper that would
  // collapse newlines (mirrors webmail's hasMeaningfulHtmlBody fallback).
  const rawHtml = React.useMemo(
    () => (html && (!text || hasMeaningfulHtmlBody(html)) ? html : null),
    [html, text],
  );
  const hasRemote = rawHtml ? hasRemoteContent(rawHtml) : false;
  const trusted = senderEmail ? isSenderTrusted(senderEmail) : false;

  // One-time override: user tapped "Load images" for this email only.
  const [allowOnce, setAllowOnce] = React.useState(false);
  React.useEffect(() => {
    setAllowOnce(false);
  }, [email.id]);

  const shouldBlock =
    hasRemote &&
    !trusted &&
    !allowOnce &&
    externalContentPolicy !== 'allow';

  const showBanner =
    hasRemote &&
    !trusted &&
    !allowOnce &&
    externalContentPolicy !== 'allow';

  const [height, setHeight] = React.useState(120);
  const [cidMap, setCidMap] = React.useState<Record<string, string>>({});
  const webviewRef = React.useRef<WebView>(null);

  React.useEffect(() => {
    setHeight(120);
    setCidMap({});
  }, [email.id]);

  React.useEffect(() => {
    if (!rawHtml || !email.attachments?.length) return;
    const refs = extractCidRefs(rawHtml);
    if (refs.length === 0) return;

    const byCid = new Map<string, { blobId: string; type: string; name?: string; size?: number }>();
    for (const att of email.attachments) {
      if (!att.cid || !att.blobId) continue;
      byCid.set(att.cid.replace(/^<|>$/g, ''), att);
    }
    const toFetch = refs
      .map((ref) => ({ ref, att: byCid.get(ref) }))
      .filter((x): x is { ref: string; att: NonNullable<ReturnType<typeof byCid.get>> } => !!x.att)
      .filter(({ att }) => !att.size || att.size <= MAX_INLINE_IMAGE_BYTES);
    if (toFetch.length === 0) return;

    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      await Promise.all(
        toFetch.map(async ({ ref, att }) => {
          try {
            const buf = await jmapClient.fetchBlobArrayBuffer(att.blobId, att.name, att.type);
            if (cancelled) return;
            const b64 = arrayBufferToBase64(buf);
            next[ref] = `data:${att.type || 'application/octet-stream'};base64,${b64}`;
          } catch (err) {
            console.warn('[EmailBodyView] cid fetch failed', ref, err);
          }
        }),
      );
      if (!cancelled && Object.keys(next).length > 0) {
        setCidMap((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => { cancelled = true; };
  }, [rawHtml, email.attachments]);

  const source = React.useMemo(() => {
    if (rawHtml) {
      return {
        html: wrapEmailHtml(rawHtml, {
          blockRemoteImages: shouldBlock,
          cidMap,
        }),
      };
    }
    const fallbackText = text ?? email.preview ?? '';
    if (!fallbackText) {
      return {
        html: wrapEmailHtml('<em style="color:#71717a">(empty message)</em>'),
      };
    }
    return { html: wrapPlainTextEmail(plainTextToSafeHtml(fallbackText)) };
  }, [rawHtml, text, email.preview, shouldBlock, cidMap]);

  const onMessage = (e: WebViewMessageEvent) => {
    const parsed = parseInt(e.nativeEvent.data, 10);
    if (Number.isNaN(parsed) || parsed <= 0) return;
    setHeight((prev) => (Math.abs(parsed - prev) < 2 ? prev : parsed));
  };

  const onLoadImages = () => setAllowOnce(true);
  const onTrustSender = () => {
    if (senderEmail) {
      addTrustedSender(senderEmail);
      setAllowOnce(true);
    }
  };

  return (
    <View style={styles.wrapper}>
      {showBanner && (
        <View style={styles.banner}>
          {externalContentPolicy === 'ask' && (
            <Pressable style={styles.bannerButton} onPress={onLoadImages} hitSlop={8}>
              <ImageIcon size={14} color={colors.textSecondary} />
              <Text style={styles.bannerButtonText}>Load external content</Text>
            </Pressable>
          )}
          {senderEmail ? (
            <Pressable style={styles.bannerButton} onPress={onTrustSender} hitSlop={8}>
              <ShieldCheck size={14} color={colors.textSecondary} />
              <Text style={styles.bannerButtonText}>Trust sender</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      <View style={[styles.webContainer, { height }]}>
        <WebView
          ref={webviewRef}
          originWhitelist={['about:*']}
          source={source}
          javaScriptEnabled
          injectedJavaScript={HEIGHT_REPORTER}
          onMessage={onMessage}
          onLoadEnd={() => {
            // Re-inject after load to cover Android cases where
            // `injectedJavaScript` runs too early to see the final layout.
            setTimeout(() => {
              webviewRef.current?.injectJavaScript(HEIGHT_REPORTER);
            }, 50);
          }}
          scrollEnabled={false}
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          setSupportMultipleWindows={false}
          thirdPartyCookiesEnabled={false}
          sharedCookiesEnabled={false}
          domStorageEnabled={false}
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
            const url = request.url;
            if (!url || url === 'about:blank' || url.startsWith('data:')) {
              return true;
            }
            if (/^(https?|mailto|tel|sms):/i.test(url)) {
              void Linking.openURL(url).catch(() => undefined);
            }
            return false;
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { width: '100%' },
  banner: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceHover,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bannerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 32,
  },
  bannerButtonText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  webContainer: {
    width: '100%',
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  webview: {
    backgroundColor: 'transparent',
    flex: 1,
  },
  webviewContainer: {
    backgroundColor: 'transparent',
  },
});
