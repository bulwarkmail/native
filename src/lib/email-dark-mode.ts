/**
 * Dark mode for HTML mail bodies (webmail lib/email-dark-mode.ts, 7401ea665,
 * 6e5e07107). Instead of inverting the whole body with a CSS filter (which
 * turns brand red into pink, flips photos that then need re-inverting and
 * emoji that need wrapping), the rendered document is read back through
 * getComputedStyle and its colours are rewritten in place:
 *
 * - Light backgrounds are darkened with their hue kept. Vivid colours (brand
 *   buttons, banners) and backgrounds that are already dark stay as sent.
 * - Text and borders only change when they lack contrast against the new
 *   background; they are then lightened (or darkened) in their own hue.
 * - Images are never touched. An element painted with a background image
 *   keeps its colours, and so does the text drawn straight on it.
 *
 * Computed styles only exist inside the WebView, so the pass runs there as an
 * injected script. Hermes keeps no function source, so the pass can't be
 * stringified from TypeScript: it lives below as JavaScript source
 * (EMAIL_DARK_MODE_LIB), and the tests evaluate that same source, so what is
 * tested is what the WebView runs.
 */

/** Canvas the converted mail sits on (white maps to this). */
export const EMAIL_DARK_BACKGROUND = '#141414';
const DARK_TEXT = '#e6e6e6';
const DARK_LINK = '#8ab4f8';

/** Class on <html> that keeps the body hidden until the pass has run. */
export const DARK_PENDING_CLASS = 'bulwark-dark-pending';

/**
 * `color-scheme` for the document root. A mail with its own dark styles gets
 * `dark`, so its `prefers-color-scheme: dark` rules apply whenever the app
 * shows it dark - not only when the phone is dark too.
 */
export function emailColorScheme(isDark: boolean, nativeDarkMode: boolean): 'light' | 'dark' {
  return isDark && nativeDarkMode ? 'dark' : 'light';
}

const ALWAYS = '(min-width: 0px)';
const NEVER = '(max-width: 0.001px)';

/**
 * Pins the mail's `prefers-color-scheme` media queries to the theme the app
 * shows it in. Inside the WebView they would follow the phone, not the app
 * (or the per-message light/dark switch). Only <style> blocks are rewritten.
 */
export function resolveColorSchemeMedia(html: string, isDark: boolean): string {
  if (!/prefers-color-scheme/i.test(html)) return html;
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, css: string, close: string) =>
    open + css.replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_q, scheme: string) =>
      (scheme.toLowerCase() === 'dark') === isDark ? ALWAYS : NEVER) + close);
}

/**
 * Stylesheet for the document head in dark mode. Sets the fallback colours
 * for mails that set none, and hides the body until the pass ran so the light
 * original never flashes. The reveal animation is a failsafe: the body shows
 * after a moment even if the pass never runs.
 */
export function emailDarkModeCss(): string {
  return `
html { background: ${EMAIL_DARK_BACKGROUND}; }
body { color: ${DARK_TEXT}; background: ${EMAIL_DARK_BACKGROUND}; }
a { color: ${DARK_LINK}; }
@keyframes bulwark-dark-reveal { to { visibility: visible; } }
html.${DARK_PENDING_CLASS} { background-color: ${EMAIL_DARK_BACKGROUND} !important; }
html.${DARK_PENDING_CLASS} body { visibility: hidden; animation: bulwark-dark-reveal 0s 1.5s forwards; }
`;
}

/** An sRGB colour with alpha, as the pass reads it from computed styles. */
export interface Rgba { r: number; g: number; b: number; a: number }

export interface EmailDarkModeOptions {
  /**
   * The user allowed remote content for this message. Only then may a remote
   * image be fetched a second time (with CORS) to look at its pixels.
   */
  remoteContentAllowed?: boolean;
}

/** What EMAIL_DARK_MODE_LIB evaluates to. */
export interface EmailDarkModeLib {
  parseComputedColor(value: string): Rgba | null;
  formatColor(color: Rgba): string;
  contrastRatio(x: Rgba, y: Rgba): number;
  darkenBackground(color: Rgba): Rgba;
  ensureContrast(color: Rgba, bg: Rgba, minRatio: number): Rgba;
  hasImage(backgroundImage: string): boolean;
  apply(doc: Document, options?: EmailDarkModeOptions): void;
}

/**
 * The pass as JavaScript source: an expression that evaluates to a factory
 * returning {@link EmailDarkModeLib}. A line-for-line port of the webmail's
 * lib/email-dark-mode.ts (colour maths in OKLab/OKLCH, WCAG contrast, the
 * read-then-write DOM pass and the image plates); keep the two in step.
 * No template literals or `${` inside: the source is a raw string.
 */
export const EMAIL_DARK_MODE_LIB = String.raw`(function () {
  'use strict';

  // Colour maths (sRGB <-> OKLab/OKLCH, WCAG contrast)

  function parseComputedColor(value) {
    var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,\/]\s*([\d.]+%?))?\s*\)$/i.exec(value || '');
    if (!m) return null;
    var a = 1;
    if (m[4] !== undefined && m[4] !== '') {
      a = m[4].charAt(m[4].length - 1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
    return { r: +m[1], g: +m[2], b: +m[3], a: a };
  }

  function formatColor(c) {
    var R = Math.round(c.r), G = Math.round(c.g), B = Math.round(c.b);
    return c.a >= 1
      ? 'rgb(' + R + ', ' + G + ', ' + B + ')'
      : 'rgba(' + R + ', ' + G + ', ' + B + ', ' + (+c.a.toFixed(3)) + ')';
  }

  function toLinear(v) {
    var c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function fromLinear(v) {
    var c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return c * 255;
  }

  function toLch(c) {
    var lr = toLinear(c.r), lg = toLinear(c.g), lb = toLinear(c.b);
    var l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    var m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    var s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    var L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    var A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    var B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) };
  }

  function lchToLinear(lch) {
    var A = lch.c * Math.cos(lch.h), B = lch.c * Math.sin(lch.h), L = lch.l;
    var l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
    var m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
    var s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    ];
  }

  function outOfGamut(lin) {
    for (var i = 0; i < 3; i++) if (lin[i] < -1e-4 || lin[i] > 1 + 1e-4) return true;
    return false;
  }

  // OKLCH back to sRGB, pulling chroma in until the colour fits the gamut.
  function fromLch(lch, a) {
    var c = lch.c;
    var lin = lchToLinear({ l: lch.l, c: c, h: lch.h });
    for (var i = 0; i < 24 && outOfGamut(lin); i++) {
      c *= 0.9;
      lin = lchToLinear({ l: lch.l, c: c, h: lch.h });
    }
    var out = lin.map(function (v) {
      return Math.min(255, Math.max(0, fromLinear(Math.min(1, Math.max(0, v)))));
    });
    return { r: out[0], g: out[1], b: out[2], a: a };
  }

  function luminance(c) {
    return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
  }

  function contrastRatio(x, y) {
    var lx = luminance(x), ly = luminance(y);
    return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05);
  }

  function sameColor(x, y) {
    return Math.round(x.r) === Math.round(y.r) && Math.round(x.g) === Math.round(y.g)
      && Math.round(x.b) === Math.round(y.b) && x.a === y.a;
  }

  // Paints a translucent colour over an opaque one.
  function composite(top, under) {
    var a = top.a;
    return {
      r: top.r * a + under.r * (1 - a),
      g: top.g * a + under.g * (1 - a),
      b: top.b * a + under.b * (1 - a),
      a: 1
    };
  }

  // Lightness white lands on, and the bottom of the "already dark" range.
  var BG_WHITE_L = 0.2;
  var BG_DARK_L = 0.45;
  // Chroma from which a background counts as a deliberate, vivid colour.
  var VIVID_CHROMA = 0.1;

  // Dark counterpart of a background colour. Light colours are mirrored into
  // the dark range (white -> the dark canvas, light grey -> a little lighter,
  // so the mail's card/canvas layering survives), mid greys move down to meet
  // that range, and vivid or already-dark colours are left alone.
  function darkenBackground(color) {
    if (color.a === 0) return color;
    var lch = toLch(color);
    if (lch.l <= BG_DARK_L) return color;
    if (lch.c >= VIVID_CHROMA) return color;
    var l;
    if (lch.l >= 0.7) {
      // 1.0 -> 0.2, 0.7 -> 0.38
      l = BG_WHITE_L + (1 - lch.l) * 0.6;
    } else {
      // 0.45 (kept) ... 0.7 (-> 0.38): fold mid greys into the dark range.
      l = BG_DARK_L - ((lch.l - BG_DARK_L) / (0.7 - BG_DARK_L)) * (BG_DARK_L - 0.38);
    }
    return fromLch({ l: l, c: lch.c, h: lch.h }, color.a);
  }

  // Returns color if it already reads against bg, otherwise a colour of the
  // same hue moved away from the background's lightness until it reaches
  // minRatio. Dark text on a dark background is mirrored first (black -> near
  // white, dark grey -> light grey), which keeps the sender's hierarchy of
  // text greys instead of flattening them all to one value.
  function ensureContrast(color, bg, minRatio) {
    if (color.a === 0) return color;
    var opaque = color.a < 1 ? composite(color, bg) : color;
    if (contrastRatio(opaque, bg) >= minRatio) return color;
    var lch = toLch(opaque);
    var bgL = toLch(bg).l;
    var lighten = bgL < 0.6;
    var l = lighten ? Math.max(lch.l, 0.96 - lch.l * 0.5) : Math.min(lch.l, 0.3);
    var out = fromLch({ l: l, c: lch.c, h: lch.h }, 1);
    for (var i = 0; i < 40 && contrastRatio(out, bg) < minRatio; i++) {
      l = lighten ? Math.min(1, l + 0.02) : Math.max(0, l - 0.02);
      out = fromLch({ l: l, c: lch.c, h: lch.h }, 1);
      if (l === 0 || l === 1) break;
    }
    return out;
  }

  // Rewrites every rgb()/rgba() in a computed gradient.
  function mapGradientColors(value, map) {
    return value.replace(/rgba?\([^)]*\)/gi, function (m) {
      var c = parseComputedColor(m);
      return c ? formatColor(map(c)) : m;
    });
  }

  // The DOM pass

  var BORDER_SIDES = ['top', 'right', 'bottom', 'left'];
  var WHITE = { r: 255, g: 255, b: 255, a: 1 };
  var SKIP_TAGS = {
    IMG: 1, VIDEO: 1, CANVAS: 1, PICTURE: 1, SOURCE: 1, svg: 1, SVG: 1, STYLE: 1, SCRIPT: 1,
    BR: 1, WBR: 1, HEAD: 1, TITLE: 1, META: 1, LINK: 1
  };

  // True for a background-image that actually paints a picture.
  function hasImage(backgroundImage) {
    if (!backgroundImage || backgroundImage === 'none') return false;
    // The blocker rewrites remote urls to url() (computed as url("")); those
    // paint nothing.
    return /url\(/i.test(backgroundImage.replace(/url\(\s*(?:""|''|)\s*\)/gi, ''));
  }

  // Lifts a kept dark fill that stood out from its light surroundings (a
  // near-black button on a white card) but now sinks into the darkened
  // surface around it.
  function keepSeparation(next, original, parent) {
    if (next !== original || original.a < 0.9) return next;
    if (contrastRatio(original, parent.original) < 3) return next;
    var target = 1.8;
    if (contrastRatio(next, parent.bg) >= target) return next;
    var lch = toLch(next);
    var parentL = toLch(parent.bg).l;
    var l = Math.max(lch.l, parentL);
    var out = next;
    for (var i = 0; i < 25 && contrastRatio(out, parent.bg) < target; i++) {
      l += 0.02;
      out = fromLch({ l: l, c: lch.c, h: lch.h }, next.a);
    }
    return out;
  }

  // Looks at an image's pixels: does it have see-through areas, and would
  // what it draws there disappear against bg? 'unknown' when the pixels can't
  // be read (a cross-origin image without CORS).
  function judgeImagePixels(source, doc, bg) {
    var w = source.naturalWidth, h = source.naturalHeight;
    if (!w || !h) return 'fine';
    var scale = Math.min(1, 48 / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    var canvas = doc.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 'unknown';
    var data;
    try {
      ctx.drawImage(source, 0, 0, cw, ch);
      data = ctx.getImageData(0, 0, cw, ch).data;
    } catch (e) {
      return 'unknown';
    }
    var clear = 0, drawn = 0, hidden = 0;
    for (var i = 0; i < data.length; i += 4) {
      var a = data[i + 3] / 255;
      if (a < 0.5) { clear++; continue; }
      drawn++;
      var px = composite({ r: data[i], g: data[i + 1], b: data[i + 2], a: a }, bg);
      if (contrastRatio(px, bg) < 2) hidden++;
    }
    var total = data.length / 4;
    // Opaque images cover any plate; mostly-readable artwork doesn't need one.
    if (clear / total < 0.02 || drawn === 0) return 'fine';
    return hidden / drawn > 0.35 ? 'plate' : 'fine';
  }

  function whenLoaded(img) {
    if (img.complete) return Promise.resolve(img.naturalWidth > 0);
    return new Promise(function (resolve) {
      img.addEventListener('load', function () { resolve(true); }, { once: true });
      img.addEventListener('error', function () { resolve(false); }, { once: true });
    });
  }

  // Loads a second copy of a remote image with CORS so its pixels can be read.
  function loadCorsCopy(img, doc) {
    var src = img.currentSrc || img.src;
    if (!/^https?:/i.test(src)) return Promise.resolve(null);
    var copy = doc.createElement('img');
    copy.crossOrigin = 'anonymous';
    copy.referrerPolicy = 'no-referrer';
    var loaded = new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(null); }, 8000);
      copy.onload = function () { clearTimeout(timer); resolve(copy); };
      copy.onerror = function () { clearTimeout(timer); resolve(null); };
    });
    copy.src = src;
    return loaded;
  }

  function plateIfNeeded(img, surface, options) {
    return whenLoaded(img).then(function (ok) {
      if (!ok) return;
      var doc = img.ownerDocument;
      // Spacers and tracking pixels.
      if (img.naturalWidth <= 2 && img.naturalHeight <= 2) return;
      var verdict = judgeImagePixels(img, doc, surface.bg);
      var next = verdict === 'unknown' && options.remoteContentAllowed
        ? loadCorsCopy(img, doc).then(function (copy) {
          return copy ? judgeImagePixels(copy, doc, surface.bg) : verdict;
        })
        : Promise.resolve(verdict);
      return next.then(function (v) {
        // Pixels we can't read get the plate: a light box around a logo is
        // better than a logo that isn't there.
        if (v === 'fine' || !img.isConnected) return;
        img.style.setProperty('background-color', formatColor(surface.original), 'important');
      });
    }).catch(function () {});
  }

  function each(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }

  // Converts a rendered mail document to dark colours in place. Call once,
  // after the document has laid out; image plates are decided once each
  // image has loaded, after this returns.
  function apply(doc, options) {
    options = options || {};
    var win = doc.defaultView;
    var body = doc.body;
    try {
      if (!win || !body) return;
      // Un-pin the canvas to read the mail's own; nothing paints before the
      // writes below, so the light original never shows.
      var html = doc.documentElement;
      html.classList.remove('bulwark-dark-pending');
      var ours = { r: 20, g: 20, b: 20, a: 1 };
      var canvas = parseComputedColor(win.getComputedStyle(html).backgroundColor);
      // A mail that paints <html> itself gets that canvas darkened like any
      // other fill; left alone it shows wherever the body doesn't cover it.
      var mailCanvas = canvas && canvas.a === 1 && !sameColor(canvas, ours) ? canvas : null;
      var base = mailCanvas ? darkenBackground(mailCanvas) : ours;

      // Read everything first, then write: interleaving would force a style
      // recalc per element.
      var elements = [body];
      each(body.querySelectorAll('*'), function (el) {
        if (!SKIP_TAGS[el.tagName] && !el.closest('svg')) elements.push(el);
      });
      var snaps = elements.map(function (el) {
        var cs = win.getComputedStyle(el);
        return {
          el: el,
          color: parseComputedColor(cs.color),
          bg: parseComputedColor(cs.backgroundColor),
          bgImage: cs.backgroundImage,
          borders: BORDER_SIDES.map(function (side) {
            return cs.getPropertyValue('border-' + side + '-style') !== 'none'
              && parseFloat(cs.getPropertyValue('border-' + side + '-width')) > 0
              ? parseComputedColor(cs.getPropertyValue('border-' + side + '-color'))
              : null;
          })
        };
      });

      // The original canvas is the mail's own or white: that is what the
      // light view paints.
      var root = { bg: base, original: mailCanvas || WHITE, onImage: false };
      var surfaces = new Map();
      var surfaceOf = function (el) {
        for (var n = el; n; n = n.parentElement) {
          var s = surfaces.get(n);
          if (s) return s;
        }
        return root;
      };

      var writes = [];
      if (mailCanvas && base !== mailCanvas) {
        writes.push(function () { html.style.setProperty('background-color', formatColor(base), 'important'); });
      }
      snaps.forEach(function (snap) {
        var el = snap.el;
        var parent = el === body ? root : surfaceOf(el.parentElement);
        var surface = parent;

        if (hasImage(snap.bgImage)) {
          // Picture background: keep the element's own fill (it shows
          // wherever the picture is transparent or fails to load) and its
          // text as sent.
          var fill = snap.bg && snap.bg.a > 0 ? composite(snap.bg, parent.bg) : parent.bg;
          surface = { bg: fill, original: fill, onImage: true };
        } else {
          if (snap.bgImage && snap.bgImage !== 'none' && !parent.onImage) {
            var gradient = mapGradientColors(snap.bgImage, darkenBackground);
            if (gradient !== snap.bgImage) {
              writes.push(function () { el.style.setProperty('background-image', gradient, 'important'); });
            }
          }
          // A translucent box over a picture still shows the picture, so it
          // keeps its colours; an opaque one is a surface of its own.
          if (el === body && snap.bg && sameColor(snap.bg, ours)) {
            // Our own dark canvas (emailDarkModeCss), not a fill the sender
            // chose: in the light view this is the white page.
          } else if (snap.bg && snap.bg.a > 0 && !(parent.onImage && snap.bg.a < 0.9)) {
            var original = snap.bg;
            // The body has no surroundings to stand out from.
            var nextBg = parent.onImage || el === body
              ? darkenBackground(original)
              : keepSeparation(darkenBackground(original), original, parent);
            surface = {
              bg: composite(nextBg, parent.bg),
              original: composite(original, parent.original),
              onImage: false
            };
            if (nextBg !== original) {
              writes.push(function () { el.style.setProperty('background-color', formatColor(nextBg), 'important'); });
            }
          }
        }
        surfaces.set(el, surface);

        if (surface.onImage) return;

        if (snap.color) {
          var nextColor = ensureContrast(snap.color, surface.bg, 4.5);
          if (nextColor !== snap.color) {
            writes.push(function () { el.style.setProperty('color', formatColor(nextColor), 'important'); });
          }
        }
        snap.borders.forEach(function (border, i) {
          if (!border || border.a === 0) return;
          // Borders sit between the element and its parent; a light rule on a
          // light mail darkens with the backgrounds, a dark one is lifted
          // just enough to stay visible.
          var darkened = darkenBackground(border);
          var nextBorder = darkened !== border ? darkened : ensureContrast(border, parent.bg, 1.6);
          if (nextBorder !== border) {
            writes.push(function () {
              el.style.setProperty('border-' + BORDER_SIDES[i] + '-color', formatColor(nextBorder), 'important');
            });
          }
        });
      });

      // Images keep their pixels, but a transparent one (a black logo, a dark
      // icon) was drawn for the light background it sat on and can vanish on
      // the darkened one. Those get that original background back behind them.
      var plates = [];
      each(body.querySelectorAll('img'), function (img) {
        var surface = surfaceOf(img.parentElement);
        if (surface.onImage || surface.bg === surface.original) return;
        if (toLch(surface.original).l < 0.7 || contrastRatio(surface.original, surface.bg) < 3) return;
        plates.push({ img: img, surface: surface });
      });

      writes.forEach(function (write) { write(); });
      plates.forEach(function (p) { plateIfNeeded(p.img, p.surface, options); });
    } finally {
      doc.documentElement.classList.remove('bulwark-dark-pending');
    }
  }

  return {
    parseComputedColor: parseComputedColor,
    formatColor: formatColor,
    contrastRatio: contrastRatio,
    darkenBackground: darkenBackground,
    ensureContrast: ensureContrast,
    hasImage: hasImage,
    apply: apply
  };
})`;

/**
 * The script the body view injects into an HTML mail shown dark: runs the
 * pass once per document (the view injects its scripts again after load) and
 * asks for a fresh height report.
 */
export function buildEmailDarkModeScript(options: EmailDarkModeOptions = {}): string {
  const opts = JSON.stringify({ remoteContentAllowed: !!options.remoteContentAllowed });
  return `
(function () {
  if (document.__rnDarkRecolorDone || !document.body) return;
  document.__rnDarkRecolorDone = true;
  try {
    (${EMAIL_DARK_MODE_LIB})().apply(document, ${opts});
  } catch (e) {
    document.documentElement.classList.remove('${DARK_PENDING_CLASS}');
  }
  if (window.__rnReport) setTimeout(window.__rnReport, 0);
})();
true;
`;
}
