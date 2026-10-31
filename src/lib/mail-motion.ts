/**
 * Reduce motion inside a message body (webmail lib/mail-reading.ts
 * MAIL_REDUCED_MOTION_CSS, 24a13cc1f, and lib/animated-images.ts,
 * bb7869798): CSS animations and transitions stop, and each animated GIF,
 * WebP or APNG shows a still frame with a Play button.
 *
 * The page allows no script of its own, so the pause runs as a script the
 * body view injects; the frame check is written out as a string because the
 * app's JS engine (Hermes) can't hand a function's source to the page.
 */

/** Stops CSS animations and transitions in a mail. */
export const MAIL_REDUCED_MOTION_CSS = '*,*::before,*::after{animation-duration:0.01ms!important;animation-iteration-count:1!important;animation-delay:0s!important;transition-duration:0.01ms!important;transition-delay:0s!important;scroll-behavior:auto!important}';

/** Puts the reduce-motion style sheet into a built body document. */
export function withReducedMotion(html: string): string {
  const style = `<style data-bulwark-reduced-motion>${MAIL_REDUCED_MOTION_CSS}</style>`;
  const at = html.lastIndexOf('</body>');
  return at < 0 ? html + style : html.slice(0, at) + style + html.slice(at);
}

/**
 * `function isAnimatedImageData(bytes)`: whether image bytes hold more than
 * one frame (GIF image descriptors, an APNG acTL chunk, the WebP animation
 * flag). Shared by the page script and the tests.
 */
export const IS_ANIMATED_SOURCE = `function isAnimatedImageData(bytes) {
  if (!bytes || bytes.length < 12) return false;
  function ascii(start, length) {
    var s = '';
    for (var k = start; k < start + length && k < bytes.length; k++) s += String.fromCharCode(bytes[k]);
    return s;
  }
  var i;
  if (ascii(0, 4) === 'GIF8') {
    i = 13;
    var flags = bytes[10];
    if (flags & 0x80) i += 3 * (1 << ((flags & 0x07) + 1));
    var frames = 0;
    var skipSubBlocks = function () {
      while (i < bytes.length && bytes[i] !== 0) i += bytes[i] + 1;
      i += 1;
    };
    while (i < bytes.length) {
      var block = bytes[i];
      if (block === 0x2c) {
        frames += 1;
        if (frames > 1) return true;
        var local = bytes[i + 9];
        i += 10;
        if (local & 0x80) i += 3 * (1 << ((local & 0x07) + 1));
        i += 1;
        skipSubBlocks();
      } else if (block === 0x21) {
        i += 2;
        skipSubBlocks();
      } else {
        break;
      }
    }
    return false;
  }
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG') {
    i = 8;
    while (i + 8 <= bytes.length) {
      var length = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
      var type = ascii(i + 4, 4);
      if (type === 'acTL') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      i += 12 + length;
    }
    return false;
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    if (ascii(12, 4) === 'VP8X' && bytes.length > 20) return (bytes[20] & 0x02) !== 0;
    return false;
  }
  return false;
}`;

export interface PauseLabels {
  play: string;
  pause: string;
}

const TOGGLE_ATTR = 'data-bulwark-animation';
const STILL_ATTR = 'data-bulwark-still';

const PAUSE_STYLE = `[${TOGGLE_ATTR}-wrap]{position:relative;display:inline-block;max-width:100%;line-height:0}`
  + `canvas[${STILL_ATTR}]{max-width:100%;height:auto}`
  + `button[${TOGGLE_ATTR}]{position:absolute;top:6px;inset-inline-start:6px;z-index:1;min-width:32px;min-height:32px;padding:4px 10px;border:2px solid #fff;border-radius:999px;background:rgba(0,0,0,.75);color:#fff;font:600 13px/1.2 system-ui,sans-serif;animation:none!important;transition:none!important}`;

/**
 * Script that freezes the animated images of the body: each one is swapped
 * for a canvas holding its first frame, with a Play button on top; Play shows
 * the moving image again and the button becomes Pause. Inline images (data:
 * URIs) are checked by their bytes; a remote image only by its name (.gif,
 * .apng), since the page can't fetch it. Runs once per document.
 */
export function buildPauseAnimatedImagesScript(labels: PauseLabels): string {
  const cfg = JSON.stringify({ play: labels.play, pause: labels.pause, style: PAUSE_STYLE });
  return `
(function () {
  if (document.__rnPauseImages || !document.body) return;
  document.__rnPauseImages = true;
  var C = ${cfg};
  var T = '${TOGGLE_ATTR}';
  var S = '${STILL_ATTR}';
  ${IS_ANIMATED_SOURCE}
  function dataBytes(src) {
    var m = /^data:[^,]*;base64,([\\s\\S]*)$/i.exec(src);
    if (!m) return null;
    try {
      var bin = atob(m[1].replace(/\\s+/g, ''));
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) { return null; }
  }
  function mayMove(src) {
    if (/^data:/i.test(src)) return isAnimatedImageData(dataBytes(src));
    if (/^https?:/i.test(src)) {
      try { return /\\.(gif|apng)$/i.test(new URL(src).pathname); } catch (e) { return false; }
    }
    return false;
  }
  function draw(img, canvas) {
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return false;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    try { ctx.drawImage(img, 0, 0); } catch (e) { return false; }
    return true;
  }
  function freeze(img) {
    if (img.hasAttribute(S) || img.naturalWidth <= 1) return;
    img.setAttribute(S, '');
    if (!mayMove(img.currentSrc || img.getAttribute('src') || '')) return;
    var canvas = document.createElement('canvas');
    if (!draw(img, canvas)) return;
    var width = img.getBoundingClientRect().width;
    canvas.setAttribute(S, '');
    ['class', 'style'].forEach(function (a) { var v = img.getAttribute(a); if (v) canvas.setAttribute(a, v); });
    if (width > 0) canvas.style.width = width + 'px';
    var alt = (img.getAttribute('alt') || '').trim();
    if (alt) { canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', alt); }
    else canvas.setAttribute('aria-hidden', 'true');
    var wrap = document.createElement('span');
    wrap.setAttribute(T + '-wrap', '');
    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute(T, 'paused');
    button.textContent = C.play;
    img.parentNode && img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(button);
    wrap.appendChild(canvas);
    wrap.appendChild(img);
    img.style.setProperty('display', 'none', 'important');
  }
  var style = document.createElement('style');
  style.textContent = C.style;
  (document.head || document.body).appendChild(style);
  // Capture phase, so a button inside a linked image doesn't open the link.
  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('button[' + T + ']') : null;
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var wrap = button.parentElement;
    var canvas = wrap && wrap.querySelector('canvas[' + S + ']');
    var img = wrap && wrap.querySelector('img');
    if (!canvas || !img) return;
    if (button.getAttribute(T) === 'paused') {
      img.style.removeProperty('display');
      canvas.style.setProperty('display', 'none');
      button.setAttribute(T, 'playing');
      button.textContent = C.pause;
    } else {
      draw(img, canvas);
      canvas.style.removeProperty('display');
      img.style.setProperty('display', 'none', 'important');
      button.setAttribute(T, 'paused');
      button.textContent = C.play;
    }
  }, true);
  var imgs = document.querySelectorAll('img');
  for (var n = 0; n < imgs.length; n++) {
    (function (img) {
      if (img.complete) freeze(img);
      else img.addEventListener('load', function () { freeze(img); }, { once: true });
    })(imgs[n]);
  }
})();
true;
`;
}
