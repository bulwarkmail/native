import React from 'react';
import { View, StyleSheet, Linking, Platform, Text, Pressable } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Image as ImageIcon, ShieldCheck } from 'lucide-react-native';
import type { Email } from '../api/types';
import {
  prepareEmailHtml, wrapPlainTextEmail, plainTextToSafeHtml, extractCidRefs,
} from '../lib/email-html';
import { hasTruncatedDisplayedBody, pickEmailBody, selectRenderableHtml } from '../lib/email-body';
import { buildQuoteCollapseScript, collapsePlainTextQuotes } from '../lib/quote-collapse';
import { parseMailtoUrl } from '../lib/unsubscribe';
import { fetchInlineImageDataUri } from '../lib/email-export';
import { useSettingsStore } from '../stores/settings-store';
import { useContactsStore } from '../stores/contacts-store';
import { useLocaleStore } from '../stores/locale-store';
import { spacing, typography, type ThemePalette } from '../theme/tokens';
import { useColors, useResolvedTheme } from '../theme/colors';
import type { RootStackParamList } from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

interface EmailBodyViewProps {
  email: Email;
  senderEmail?: string;
  /** Owning account when the message lives in a shared/group mailbox. */
  jmapAccountId?: string;
  // The body is a native WebView, which on Android swallows horizontal touches
  // before the surrounding pager can see them. We detect a clear horizontal
  // swipe inside the page and report it here so the pager can change messages.
  onSwipe?: (direction: 'prev' | 'next') => void;
  // Pinch-zoom state from inside the page: `pinching` while two fingers are
  // down, `zoomed` while the content is scaled in. The hosts use it to freeze
  // the surrounding vertical scroll / horizontal pager so a zoom gesture can't
  // scroll the pane away or switch mails.
  onZoomChange?: (zoom: { pinching: boolean; zoomed: boolean }) => void;
  /** Per-message override of the light/dark rendering (More sheet toggle). */
  themeOverride?: 'light' | 'dark' | null;
  /**
   * Replace the message's own body - used when the outer message is an empty
   * envelope around a message/rfc822 attachment or a TNEF winmail.dat and the
   * real content was extracted client-side.
   */
  bodyOverride?: { html?: string | null; text?: string | null } | null;
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
      // Re-invert so the background image returns to its original
      // appearance. Matches the CSS background-image rules: re-invert even
      // when media is nested, then cancel the per-image re-invert on that
      // media so it isn't left double-inverted.
      el.style.filter = 'invert(1) hue-rotate(180deg)';
      el.querySelectorAll('img, video, svg, canvas, object, embed, input[type="image"]')
        .forEach(function (m) { m.style.filter = 'none'; });
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

// Image fix-ups, mirroring the webmail's post-render passes:
//  - collapse empty <td>/<div> wrappers left behind by blocked images so a
//    blocked newsletter doesn't show rows of empty cells;
//  - hide images that fail to load (dead/unreachable URLs) rather than leave
//    the engine's broken-image glyph and alt text as stray labels.
const IMG_FIXUP_SCRIPT = `
(function () {
  if (document.__rnImgFixupDone) return;
  var doc = document;
  if (!doc.body) return;
  document.__rnImgFixupDone = true;

  doc.querySelectorAll('img[data-blocked-src]').forEach(function (img) {
    var el = img.parentElement;
    while (el && el !== doc.body) {
      if (el.tagName === 'TD' || el.tagName === 'TH' ||
          (el.tagName === 'DIV' && el.parentElement && el.parentElement.tagName === 'TD')) {
        var hasText = (el.textContent || '').replace(/[\\s\\u00A0]+/g, '').trim();
        var hasMedia = el.querySelector('img:not([data-blocked-src]), video, canvas');
        var hasLinks = el.querySelector('a[href]');
        if (!hasText && !hasMedia && !hasLinks) {
          el.setAttribute('data-blocked-collapsed-style', el.style.cssText);
          el.style.display = 'none';
          el.style.height = '0';
          el.style.padding = '0';
          el.style.overflow = 'hidden';
        }
        break;
      }
      if (el.tagName === 'TABLE' || el.tagName === 'TR') break;
      el = el.parentElement;
    }
  });

  function hideIfBroken(img) {
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) {
      img.style.display = 'none';
    }
  }
  doc.querySelectorAll('img').forEach(function (img) {
    if (img.hasAttribute('data-blocked-src')) return;
    if (img.complete) {
      hideIfBroken(img);
    } else {
      img.addEventListener('error', function () { img.style.display = 'none'; }, { once: true });
      img.addEventListener('load', function () { hideIfBroken(img); }, { once: true });
    }
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
  // Shared zoom state, mutated by the pinch-zoom handler injected after this
  // script. "fit" is the shrink-to-fit scale, "scale" the user's pinch factor
  // on top of it, "tx" pans the zoomed overflow into view horizontally.
  // Vertical panning needs no state here: the height reports below carry the
  // scaled height, so the surrounding native ScrollView grows and scrolls.
  var Z = window.__rnZoom = window.__rnZoom || {
    scale: 1, tx: 0, pinching: false, fit: 1, layoutW: 0, avail: 0,
  };
  // Apply the combined fit × pinch transform using the cached layout numbers
  // (cheap — no reflow), clamping the pan so content edges pin to the viewport.
  function applyTransform(w) {
    var s = Z.fit * Z.scale;
    if (Z.scale > 1.001 || Z.fit < 0.999) {
      var minTx = Math.min(0, Z.avail - Z.layoutW * s);
      if (Z.tx < minTx) Z.tx = minTx;
      if (Z.tx > 0) Z.tx = 0;
      w.style.width = Z.layoutW + 'px';
      // An over-wide block in a right-to-left body overflows to the left,
      // where the top-left origin and the pan clamp don't expect it. The
      // negative right margin keeps it flush left in either direction.
      w.style.marginRight = (Z.avail - Z.layoutW) + 'px';
      w.style.transform = 'translateX(' + Z.tx + 'px) scale(' + s + ')';
    } else {
      Z.tx = 0;
      w.style.width = '100%';
      w.style.marginRight = '';
      w.style.transform = 'none';
    }
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
    w.style.marginRight = '';
    var content = w.scrollWidth;
    Z.avail = avail;
    Z.layoutW = content > avail + 1 ? content : avail;
    Z.fit = avail / Z.layoutW;
    applyTransform(w);
  }
  function measure() {
    var w = ensureWrapper();
    if (!w) return 0;
    // While a pinch is in flight only re-apply the transform — a full re-fit
    // resets the wrapper width and would thrash layout on every frame.
    if (Z.pinching) applyTransform(w);
    else fitToWidth(w);
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
  // Hooks for the pinch-zoom handler script.
  window.__rnApplyZoom = function () { var w = ensureWrapper(); if (w) applyTransform(w); };
  window.__rnReport = report;
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
    // While the content is pinch-zoomed, horizontal flicks pan the zoomed
    // content — never switch mails.
    if (window.__rnZoom && (window.__rnZoom.pinching || window.__rnZoom.scale > 1.001)) return;
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

// Pinch zoom + pan for the email content, driven entirely in the page: native
// WebView zoom can't work here because the WebView is auto-height inside a
// native ScrollView (viewport meta pins it to scale 1). A two-finger pinch
// scales the measured wrapper (on top of the shrink-to-fit scale the height
// reporter maintains) anchored at the fingers' horizontal midpoint; while
// zoomed, one-finger horizontal drags pan via translateX and vertical drags
// still scroll the surrounding ScrollView, which sees the scaled height
// through the regular height reports. Pinch moves call preventDefault so the
// engine consumes the gesture and Android parents don't intercept it; `zoom`
// messages let the RN side freeze the pane scroll / pager as a second guard.
const PINCH_ZOOM = `
(function () {
  if (window.__rnPinchInit) return;
  window.__rnPinchInit = true;
  var Z = window.__rnZoom = window.__rnZoom || {
    scale: 1, tx: 0, pinching: false, fit: 1, layoutW: 0, avail: 0,
  };
  var MAX_ZOOM = 4;
  var pinch = null; // { d0, s0, cx0, tx0 }
  var pan = null;   // { x0, tx0 }
  var rafPending = false;

  function post(msg) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }
  function apply() {
    if (window.__rnApplyZoom) window.__rnApplyZoom();
  }
  // Height reports are rAF-throttled during the gesture so the RN container
  // keeps up with the growing content without re-measuring on every move.
  function scheduleReport() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      if (window.__rnReport) window.__rnReport();
    });
  }
  function dist(t0, t1) {
    var dx = t1.clientX - t0.clientX, dy = t1.clientY - t0.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  document.addEventListener('touchstart', function (e) {
    if (e.touches.length === 2) {
      var t0 = e.touches[0], t1 = e.touches[1];
      pinch = {
        d0: dist(t0, t1) || 1,
        s0: Z.scale,
        cx0: (t0.clientX + t1.clientX) / 2,
        tx0: Z.tx,
      };
      pan = null;
      if (!Z.pinching) {
        Z.pinching = true;
        post({ type: 'zoom', pinching: true, scale: Z.scale });
      }
      e.preventDefault();
    } else if (e.touches.length === 1 && Z.scale > 1.001) {
      pan = { x0: e.touches[0].clientX, tx0: Z.tx };
    } else {
      pan = null;
    }
  }, { passive: false, capture: true });

  document.addEventListener('touchmove', function (e) {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      var t0 = e.touches[0], t1 = e.touches[1];
      var z = pinch.s0 * (dist(t0, t1) / pinch.d0);
      if (z < 1) z = 1;
      if (z > MAX_ZOOM) z = MAX_ZOOM;
      // Keep the content under the fingers' midpoint stationary horizontally:
      // the wrapper-local point that started under cx0 must map back to the
      // current midpoint at the new scale. (applyTransform clamps the result.)
      var cx = (t0.clientX + t1.clientX) / 2;
      var local = (pinch.cx0 - pinch.tx0) / (Z.fit * pinch.s0);
      Z.scale = z;
      Z.tx = cx - local * (Z.fit * z);
      apply();
      scheduleReport();
    } else if (pan && e.touches.length === 1 && Z.scale > 1.001) {
      // No preventDefault: vertical-dominant drags must keep scrolling the
      // native ScrollView around the WebView. Horizontal-dominant drags stay
      // inside the WebView and pan here.
      Z.tx = pan.tx0 + (e.touches[0].clientX - pan.x0);
      apply();
    }
  }, { passive: false, capture: true });

  function onTouchEnd(e) {
    if (pinch && e.touches.length < 2) {
      pinch = null;
      // Snap back to the fitted layout when the pinch ends near scale 1.
      if (Z.scale < 1.02) { Z.scale = 1; Z.tx = 0; }
      Z.pinching = false;
      apply();
      if (window.__rnReport) window.__rnReport();
      post({ type: 'zoom', pinching: false, scale: Z.scale });
      // A finger left on screen continues as a pan.
      if (e.touches.length === 1 && Z.scale > 1.001) {
        pan = { x0: e.touches[0].clientX, tx0: Z.tx };
      }
    }
    if (e.touches.length === 0) pan = null;
  }
  document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });
  true;
})();
`;

export default function EmailBodyView({
  email, senderEmail, jmapAccountId, onSwipe, onZoomChange, themeOverride, bodyOverride,
}: EmailBodyViewProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const navigation = useNavigation<Nav>();
  const externalContentPolicy = useSettingsStore((s) => s.externalContentPolicy);
  const isSenderTrusted = useSettingsStore((s) => s.isSenderTrusted);
  const addTrustedSender = useSettingsStore((s) => s.addTrustedSender);
  const trustedSendersAddressBook = useSettingsStore((s) => s.trustedSendersAddressBook);
  const emailAlwaysLightMode = useSettingsStore((s) => s.emailAlwaysLightMode);
  const plainTextFont = useSettingsStore((s) => s.plainTextFont);
  const messageSpacing = useSettingsStore((s) => s.messageSpacing);
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
    for (const card of contacts) {
      if (!card.emails) continue;
      for (const e of Object.values(card.emails)) {
        if (e?.address) out.add(e.address.toLowerCase());
      }
    }
    return out;
  }, [contacts, trustedSendersAddressBook]);
  // Most marketing email is authored against a white background, so dark-mode
  // inversion can wreck logos/banners. With this flag the user opts to render
  // emails on a light surface even while the rest of the app is dark; the
  // per-message toggle in the More sheet overrides both.
  const renderAsDark = themeOverride
    ? themeOverride === 'dark'
    : !emailAlwaysLightMode && resolvedTheme === 'dark';

  // RFC 8621 §4.1.4: an HTML-only message exposes the same part in textBody
  // and htmlBody, so the text part is only an alternative when its partId
  // differs (native #46). `pickEmailBody` routes by part type and id.
  const picked = React.useMemo(() => {
    if (bodyOverride) return { html: bodyOverride.html ?? null, text: bodyOverride.text ?? null };
    return pickEmailBody(email);
  }, [email, bodyOverride]);
  const rawHtml = React.useMemo(() => selectRenderableHtml(picked), [picked]);
  const text = picked.text;
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

  // Policy-driven gate (like the webmail's `externalBlocked`): the strict CSP
  // is in effect whenever the policy is not "allow" and the sender is not
  // trusted, regardless of what the detection pass finds - the pass only
  // drives the banner and the placeholder swap.
  const shouldBlock =
    !!rawHtml &&
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
      .filter((x): x is { ref: string; att: NonNullable<ReturnType<typeof byCid.get>> } => !!x.att);
    if (toFetch.length === 0) return;

    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      await Promise.all(
        toFetch.map(async ({ ref, att }) => {
          try {
            const uri = await fetchInlineImageDataUri(att, jmapAccountId);
            if (cancelled || !uri) return;
            next[ref] = uri;
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
  }, [rawHtml, email.attachments, jmapAccountId]);

  const quoteLabels = React.useMemo(() => ({
    show: t('email_viewer.show_quoted_text', 'Show quoted text'),
    hide: t('email_viewer.hide_quoted_text', 'Hide quoted text'),
  }), [t]);

  const prepared = React.useMemo(() => {
    if (rawHtml) {
      const res = prepareEmailHtml(rawHtml, {
        blockRemoteImages: shouldBlock,
        cidMap,
        isDark: renderAsDark,
        messageSpacing,
      });
      return { ...res, isHtml: true };
    }
    const fallbackText = text ?? email.preview ?? '';
    if (!fallbackText) {
      const res = prepareEmailHtml(
        `<em style="color:#71717a">${t('email_viewer.no_body_content', '(No body content available)')}</em>`,
        { isDark: renderAsDark },
      );
      return { ...res, isHtml: true };
    }
    const safe = collapsePlainTextQuotes(plainTextToSafeHtml(fallbackText), quoteLabels);
    return {
      html: wrapPlainTextEmail(safe, { isDark: renderAsDark, font: plainTextFont }),
      applyInversion: false,
      hasNativeDark: false,
      blockedExternal: false,
      isHtml: false,
    };
  }, [rawHtml, text, email.preview, shouldBlock, cidMap, renderAsDark, messageSpacing, plainTextFont, quoteLabels, t]);

  const source = React.useMemo(() => ({ html: prepared.html }), [prepared.html]);
  const showBanner = shouldBlock && prepared.blockedExternal;
  // Still cut off after the API's larger refetch (or the refetch failed).
  const showTruncated = !bodyOverride && hasTruncatedDisplayedBody(email);

  // Inversion is applied for HTML bodies in dark mode unless the email ships
  // its own dark-mode CSS - decided once by prepareEmailHtml on the same
  // input the CSS was built from, so the DOM pass and the stylesheet agree.
  const injectedJs = React.useMemo(
    () =>
      (prepared.isHtml ? buildQuoteCollapseScript(quoteLabels) : '')
      + (prepared.applyInversion ? DARK_REINVERT_SCRIPT : '')
      + (prepared.isHtml ? IMG_FIXUP_SCRIPT : '')
      + HEIGHT_REPORTER + SWIPE_DETECTOR + PINCH_ZOOM,
    [prepared.isHtml, prepared.applyInversion, quoteLabels],
  );

  const onMessage = (e: WebViewMessageEvent) => {
    const data = e.nativeEvent.data;
    // Swipe/zoom messages arrive as JSON; the height reporter posts a bare number.
    if (data.charCodeAt(0) === 123 /* '{' */) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'swipe' && (msg.dir === 'prev' || msg.dir === 'next')) {
          onSwipe?.(msg.dir);
        } else if (msg.type === 'zoom') {
          onZoomChange?.({
            pinching: !!msg.pinching,
            zoomed: typeof msg.scale === 'number' && msg.scale > 1.01,
          });
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
      // Keep the local allow-list for instant effect. The server-side "Trusted
      // Senders" address book (synced across devices) is only written when
      // the user opted into it - otherwise a book would silently appear in
      // their contacts (matches the webmail).
      addTrustedSender(senderEmail);
      if (trustedSendersAddressBook) {
        void addToTrustedSendersBook(senderEmail).catch(() => {});
      }
      setAllowOnce(true);
    }
  };

  // mailto: links inside the body open the app's own composer with the parsed
  // recipients/subject/body rather than the OS mail handler (webmail 1.8.1).
  const openMailto = (url: string) => {
    const fields = parseMailtoUrl(url);
    if (!fields) return;
    navigation.navigate('Compose', {
      prefillTo: fields.to.map((address) => ({ email: address })),
      prefillCc: fields.cc?.map((address) => ({ email: address })),
      prefillSubject: fields.subject,
      prefillBody: fields.body,
    });
  };

  return (
    <View style={styles.wrapper}>
      {showBanner && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            {t('email_viewer.external_content_warning', 'Images and external content have been blocked')}
          </Text>
          <View style={styles.bannerActions}>
            {externalContentPolicy === 'ask' && (
              <Pressable style={styles.bannerButton} onPress={onLoadImages} hitSlop={8}>
                <ImageIcon size={14} color={c.textSecondary} />
                <Text style={styles.bannerButtonText}>{t('email_viewer.load_external_content', 'Load images')}</Text>
              </Pressable>
            )}
            {senderEmail ? (
              <Pressable style={styles.bannerButton} onPress={onTrustSender} hitSlop={8}>
                <ShieldCheck size={14} color={c.textSecondary} />
                <Text style={styles.bannerButtonText}>{t('email_viewer.trust_sender', 'Always trust this sender')}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      )}
      {showTruncated && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            {t('email_viewer.body_truncated', 'This message is too large to show in full.')}
          </Text>
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
            // A (re)load resets the page's zoom state to 1 — drop any host-side
            // scroll locks so they can't go stale (e.g. cid images arriving
            // reload the source mid-zoom).
            onZoomChange?.({ pinching: false, zoomed: false });
            // Re-inject after load to cover Android cases where
            // `injectedJavaScript` runs too early to see the final layout. Every
            // pass guards itself so running it again here is a no-op once the
            // body has been processed.
            setTimeout(() => {
              webviewRef.current?.injectJavaScript(injectedJs);
            }, 50);
          }}
          scrollEnabled={false}
          // Native Android zoom would scale the viewport inside the fixed-size
          // container; pinch zoom is implemented in the page instead.
          setBuiltInZoomControls={false}
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
            // Only the initial about:blank document may load. A `data:` (or
            // any other) navigation would replace the email body with no way
            // back, so it is refused; images are reachable via the chips.
            if (!url || url === 'about:blank') return true;
            if (/^mailto:/i.test(url)) {
              openMailto(url);
              return false;
            }
            if (/^(https?|tel|sms):/i.test(url)) {
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
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: c.surfaceHover,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  bannerText: {
    ...typography.caption,
    color: c.textMuted,
  },
  bannerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
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
