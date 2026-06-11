import React from 'react';
import { View, StyleSheet, Linking, Platform, Text, Pressable } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Image as ImageIcon, ShieldCheck } from 'lucide-react-native';
import type { Email } from '../api/types';
import { wrapEmailHtml, wrapPlainTextEmail, plainTextToSafeHtml, extractCidRefs, hasRemoteContent, hasMeaningfulHtmlBody, hasNativeDarkMode } from '../lib/email-html';
import { jmapClient } from '../api/jmap-client';
import { useSettingsStore } from '../stores/settings-store';
import { useContactsStore } from '../stores/contacts-store';
import { spacing, typography, type ThemePalette } from '../theme/tokens';
import { useColors, useResolvedTheme } from '../theme/colors';

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
  // The body is a native WebView, which on Android swallows horizontal touches
  // before the surrounding pager can see them. We detect a clear horizontal
  // swipe inside the page and report it here so the pager can change messages.
  onSwipe?: (direction: 'prev' | 'next') => void;
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

// Dark-mode re-inversion, mirroring the webmail's handleIframeLoad pass. The
// body's `filter: invert(1)` flips colored emoji (yellow smiley -> blue, red
// heart -> cyan) and stylesheet-defined background images, which the static CSS
// attribute selectors can't reach. This walks the DOM once and wraps/re-inverts
// those so they keep their original colors. Only injected when inversion is on.
const DARK_REINVERT_SCRIPT = `
(function () {
  if (document.__rnDarkInvertDone) return;
  var doc = document;
  var win = window;
  if (!doc.body) return;
  document.__rnDarkInvertDone = true;

  // Re-invert elements with stylesheet-defined background images (CSS attribute
  // selectors only catch inline styles, not rules that survive in <style>).
  doc.body.querySelectorAll('*').forEach(function (el) {
    // Skip elements already handled by CSS attribute selectors.
    if (el.style.backgroundImage || el.style.background ||
        el.hasAttribute('background') || el.hasAttribute('bgcolor')) return;
    // Skip leaf media elements (already re-inverted by CSS).
    var tag = el.tagName;
    if (['IMG','VIDEO','SVG','CANVAS','OBJECT','EMBED'].indexOf(tag) !== -1) return;
    var computed = win.getComputedStyle(el);
    if (computed.backgroundImage && computed.backgroundImage !== 'none') {
      // Only re-invert if this container doesn't have media children.
      if (!el.querySelector('img, video, svg, canvas, object, embed')) {
        el.style.filter = 'invert(1) hue-rotate(180deg)';
      }
    }
  });

  // Re-invert emoji glyphs so they keep their original colors. Wrap each emoji
  // run in a span that re-inverts. Only act when the ancestor invert depth is
  // odd - emojis inside a double-inverted bgcolor container already render at
  // their original colors.
  var emojiRe;
  try {
    emojiRe = new RegExp('\\\\p{RGI_Emoji}', 'gv');
  } catch (e) {
    emojiRe = /\\p{Extended_Pictographic}(?:\\uFE0F)?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F)?)*/gu;
  }
  var emojiTestRe = /\\p{Extended_Pictographic}/u;
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, IFRAME: 1 };

  function isOddInvertDepth(start) {
    var count = 0;
    var n = start;
    while (n) {
      if (n === doc.body) { count++; break; }
      var cs = win.getComputedStyle(n);
      if (cs.filter && cs.filter.indexOf('invert') !== -1) count++;
      n = n.parentElement;
    }
    return count % 2 === 1;
  }

  var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      var p = node.parentElement;
      while (p) {
        if (SKIP_TAGS[p.tagName]) return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return emojiTestRe.test(node.nodeValue || '')
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });

  var emojiTextNodes = [];
  var cur;
  while ((cur = walker.nextNode())) emojiTextNodes.push(cur);

  emojiTextNodes.forEach(function (textNode) {
    var parent = textNode.parentElement;
    if (!parent || !isOddInvertDepth(parent)) return;
    var text = textNode.nodeValue || '';
    emojiRe.lastIndex = 0;
    var frag = doc.createDocumentFragment();
    var lastIndex = 0;
    var m;
    while ((m = emojiRe.exec(text)) !== null) {
      if (m.index > lastIndex) {
        frag.appendChild(doc.createTextNode(text.slice(lastIndex, m.index)));
      }
      var span = doc.createElement('span');
      span.style.cssText = 'filter:invert(1) hue-rotate(180deg)';
      span.textContent = m[0];
      frag.appendChild(span);
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex === 0) return;
    if (lastIndex < text.length) {
      frag.appendChild(doc.createTextNode(text.slice(lastIndex)));
    }
    parent.replaceChild(frag, textNode);
  });
})();
`;

const HEIGHT_REPORTER = `
(function () {
  // One-time: wrap body contents in a block-level div we can measure reliably.
  // body.scrollHeight on Android WebView is pinned to the container viewport
  // height, so we can't trust it. A dedicated wrapper gives a deterministic
  // bounding box.
  var wrapperEl = null;
  function ensureWrapper() {
    var b = document.body;
    if (!b) return null;
    if (wrapperEl && wrapperEl.isConnected) return wrapperEl;
    var wrap = document.getElementById('__rn_email_body_wrap__');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = '__rn_email_body_wrap__';
      wrap.style.display = 'block';
      wrap.style.width = '100%';
      wrap.style.transformOrigin = 'top left';
      while (b.firstChild) wrap.appendChild(b.firstChild);
      b.appendChild(wrap);
    }
    wrapperEl = wrap;
    return wrap;
  }
  // The width available for the email content (body content-box).
  function availWidth() {
    var b = document.body;
    var cs = window.getComputedStyle(b);
    var padL = parseFloat(cs.paddingLeft) || 0;
    var padR = parseFloat(cs.paddingRight) || 0;
    return b.clientWidth - padL - padR;
  }
  // Shrink-to-fit: emails authored at a fixed width (e.g. 600px tables) overflow
  // a phone viewport and force horizontal scrolling. Lay the content out at its
  // natural width, then scale the whole block down so its widest element fits
  // the screen — the way native mail clients do. No sideways scrolling.
  function fitToWidth(w) {
    if (!w) return;
    var avail = availWidth();
    if (avail <= 0) return;
    // Reset to full width so wrapping content reports its true overflow extent
    // (the widest unbreakable element) rather than a previously-scaled box.
    w.style.width = '100%';
    var content = w.scrollWidth;
    if (content > avail + 1) {
      var scale = avail / content;
      w.style.width = content + 'px';
      w.style.transform = 'scale(' + scale + ')';
    } else {
      w.style.transform = 'none';
    }
  }
  function measure() {
    var w = ensureWrapper();
    if (!w) return 0;
    fitToWidth(w);
    // getBoundingClientRect reflects the applied transform, so r.height is the
    // already-scaled visual height of the content.
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
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        // Ignore the style mutations fitToWidth() applies to the wrapper itself,
        // otherwise scaling would re-trigger a measure and loop indefinitely.
        var rec = records[i];
        if (rec.target === wrapperEl && rec.type === 'attributes') continue;
        report();
        return;
      }
    });
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

// Detect a clear horizontal flick inside the WebView and report it. Uses
// capture-phase, passive listeners so it never blocks vertical scrolling, text
// selection, or link taps — it only reacts to a quick, horizontal-dominant
// gesture on release. Guarded so re-injection (onLoadEnd) is a no-op.
const SWIPE_DETECTOR = `
(function () {
  if (window.__rnSwipeInit) return;
  window.__rnSwipeInit = true;
  var x0 = 0, y0 = 0, t0 = 0, tracking = false;
  document.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { tracking = false; return; }
    var t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); tracking = true;
  }, { passive: true, capture: true });
  document.addEventListener('touchend', function (e) {
    if (!tracking) return;
    tracking = false;
    var t = e.changedTouches[0];
    if (!t) return;
    var dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
    if (dt < 700 && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.8) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'swipe', dir: dx < 0 ? 'next' : 'prev' }));
      }
    }
  }, { passive: true, capture: true });
  true;
})();
`;

export default function EmailBodyView({ email, senderEmail, onSwipe }: EmailBodyViewProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const externalContentPolicy = useSettingsStore((s) => s.externalContentPolicy);
  const isSenderTrusted = useSettingsStore((s) => s.isSenderTrusted);
  const addTrustedSender = useSettingsStore((s) => s.addTrustedSender);
  const trustedSendersAddressBook = useSettingsStore((s) => s.trustedSendersAddressBook);
  const emailAlwaysLightMode = useSettingsStore((s) => s.emailAlwaysLightMode);
  const hideInlineImageAttachments = useSettingsStore((s) => s.hideInlineImageAttachments);
  const contacts = useContactsStore((s) => s.contacts);
  const trustedSenderEmails = useContactsStore((s) => s.trustedSenderEmails);
  const trustedSendersLoaded = useContactsStore((s) => s.trustedSendersLoaded);
  const loadTrustedSendersBook = useContactsStore((s) => s.loadTrustedSendersBook);
  const addToTrustedSendersBook = useContactsStore((s) => s.addToTrustedSendersBook);
  const resolvedTheme = useResolvedTheme();

  // Passively load the dedicated "Trusted Senders" address book once so its
  // entries (synced across devices) feed the external-content trust check. We
  // do not create the book here — it is created lazily when a sender is trusted.
  React.useEffect(() => {
    if (!trustedSendersLoaded) void loadTrustedSendersBook(false);
  }, [trustedSendersLoaded, loadTrustedSendersBook]);
  // Index the address book once per render so the trusted-sender check below
  // is O(1) per email. Only used when the matching setting is on.
  const addressBookEmails = React.useMemo(() => {
    if (!trustedSendersAddressBook) return null;
    const out = new Set<string>();
    for (const c of contacts) {
      if (!c.emails) continue;
      for (const e of Object.values(c.emails)) {
        if (e?.address) out.add(e.address.toLowerCase());
      }
    }
    return out;
  }, [contacts, trustedSendersAddressBook]);
  // Most marketing email is authored against a white background, so dark-mode
  // inversion can wreck logos/banners. With this flag the user opts to render
  // emails on a light surface even while the rest of the app is dark.
  const renderAsDark = !emailAlwaysLightMode && resolvedTheme === 'dark';

  const html = React.useMemo(() => extractHtmlBody(email), [email]);
  const text = React.useMemo(() => extractTextBody(email), [email]);
  // Prefer textBody when the HTML is a minimal auto-generated wrapper that would
  // collapse newlines (mirrors webmail's hasMeaningfulHtmlBody fallback).
  const rawHtml = React.useMemo(
    () => (html && (!text || hasMeaningfulHtmlBody(html)) ? html : null),
    [html, text],
  );
  const hasRemote = rawHtml ? hasRemoteContent(rawHtml) : false;
  const trusted = senderEmail
    ? isSenderTrusted(senderEmail)
      || trustedSenderEmails.includes(senderEmail.toLowerCase())
      || (addressBookEmails?.has(senderEmail.toLowerCase()) ?? false)
    : false;

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
          isDark: renderAsDark,
        }),
      };
    }
    const fallbackText = text ?? email.preview ?? '';
    if (!fallbackText) {
      return {
        html: wrapEmailHtml('<em style="color:#71717a">(empty message)</em>', {
          isDark: renderAsDark,
        }),
      };
    }
    return {
      html: wrapPlainTextEmail(plainTextToSafeHtml(fallbackText), { isDark: renderAsDark }),
    };
  }, [rawHtml, text, email.preview, shouldBlock, cidMap, renderAsDark]);

  // Inversion is applied for HTML bodies in dark mode unless the email ships its
  // own dark-mode CSS. When it's on, prepend the DOM re-inversion pass (emoji +
  // stylesheet backgrounds) so it runs before the height reporter measures.
  const applyInversion =
    !!rawHtml && renderAsDark && !hasNativeDarkMode(rawHtml);
  const injectedJs = React.useMemo(
    () =>
      (applyInversion ? DARK_REINVERT_SCRIPT + HEIGHT_REPORTER : HEIGHT_REPORTER)
      + SWIPE_DETECTOR,
    [applyInversion],
  );

  const onMessage = (e: WebViewMessageEvent) => {
    const data = e.nativeEvent.data;
    // Swipe messages arrive as JSON; the height reporter posts a bare number.
    if (data.charCodeAt(0) === 123 /* '{' */) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'swipe' && (msg.dir === 'prev' || msg.dir === 'next')) {
          onSwipe?.(msg.dir);
        }
      } catch { /* ignore malformed */ }
      return;
    }
    const parsed = parseInt(data, 10);
    if (Number.isNaN(parsed) || parsed <= 0) return;
    setHeight((prev) => (Math.abs(parsed - prev) < 2 ? prev : parsed));
  };

  const onLoadImages = () => setAllowOnce(true);
  const onTrustSender = () => {
    if (senderEmail) {
      // Keep the local allow-list for instant effect, and persist to the
      // dedicated "Trusted Senders" address book so the trust syncs across
      // devices (matches the webmail behavior).
      addTrustedSender(senderEmail);
      void addToTrustedSendersBook(senderEmail).catch(() => {});
      setAllowOnce(true);
    }
  };

  return (
    <View style={styles.wrapper}>
      {showBanner && (
        <View style={styles.banner}>
          {externalContentPolicy === 'ask' && (
            <Pressable style={styles.bannerButton} onPress={onLoadImages} hitSlop={8}>
              <ImageIcon size={14} color={c.textSecondary} />
              <Text style={styles.bannerButtonText}>Load external content</Text>
            </Pressable>
          )}
          {senderEmail ? (
            <Pressable style={styles.bannerButton} onPress={onTrustSender} hitSlop={8}>
              <ShieldCheck size={14} color={c.textSecondary} />
              <Text style={styles.bannerButtonText}>Trust sender</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      <View style={[styles.webContainer, { height }]}>
        <WebView
          ref={webviewRef}
          originWhitelist={['about:blank']}
          source={source}
          javaScriptEnabled
          injectedJavaScript={injectedJs}
          onMessage={onMessage}
          onLoadEnd={() => {
            // Re-inject after load to cover Android cases where
            // `injectedJavaScript` runs too early to see the final layout. The
            // re-inversion pass guards itself (__rnDarkInvertDone) so running it
            // again here is a no-op once the body has been processed.
            setTimeout(() => {
              webviewRef.current?.injectJavaScript(injectedJs);
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

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  wrapper: { width: '100%' },
  banner: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: c.surfaceHover,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  bannerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 32,
  },
  bannerButtonText: {
    ...typography.caption,
    color: c.textSecondary,
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
}
