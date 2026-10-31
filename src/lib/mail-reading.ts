/**
 * How the app's text size reaches a message body (webmail lib/mail-reading.ts,
 * c07ba1a37). The body renders in a WebView the app's styles don't reach, so
 * the size is carried in: as the base font size of a plain-text body, and as
 * a pass over the computed styles of an HTML body once it has laid out.
 */

/** Size of body text in a message, in CSS px at 100 %: what mail used to be fixed at. */
export const MAIL_BASE_FONT_PX = 14;

const MIN_FACTOR = 0.5;
const MAX_FACTOR = 3;

/**
 * The factor message text is drawn at: the app's text size times the
 * system font scale (Android font size, iOS Dynamic Type). Android's WebView
 * would apply the system scale on its own; the body view turns that off
 * (`textZoom` 100) so both platforms scale the same way, once.
 */
export function mailTextFactor(appFactor: number, systemFontScale: number): number {
  const app = appFactor > 0 ? appFactor : 1;
  const system = systemFontScale > 0 ? systemFontScale : 1;
  const factor = Math.round(app * system * 100) / 100;
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, factor));
}

/** The base font size of a body at `factor`, in CSS px. */
export function mailBaseFontPx(factor: number): number {
  return Math.round(MAIL_BASE_FONT_PX * factor * 100) / 100;
}

const DONE_ATTR = 'data-bulwark-text-size';

/**
 * Script injected into an HTML body that scales its text by `factor`: reads
 * every element's computed font size first and writes the scaled sizes after,
 * pinning each element to its own px size so a child sized in em doesn't grow
 * twice. A line height in px grows by the same ratio. Runs once per document
 * (the body view injects its scripts again after load). Text size works on
 * the text rather than zooming the whole mail, so a fixed-width newsletter
 * keeps its width and its text wraps inside it. Empty at factor 1.
 */
export function buildMailTextSizeScript(factor: number): string {
  if (!(factor > 0) || Math.abs(factor - 1) < 0.005) return '';
  return `
(function () {
  var F = ${JSON.stringify(factor)};
  var body = document.body;
  if (!body || body.hasAttribute('${DONE_ATTR}')) return;
  body.setAttribute('${DONE_ATTR}', '');
  var NO_TEXT = { IMG: 1, BR: 1, HR: 1, WBR: 1, PICTURE: 1, SOURCE: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, STYLE: 1, SCRIPT: 1, TEMPLATE: 1 };
  var els = [body];
  var all = body.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (NO_TEXT[el.tagName] || el.closest('svg')) continue;
    els.push(el);
  }
  var sizes = [];
  for (var j = 0; j < els.length; j++) {
    var cs = window.getComputedStyle(els[j]);
    var font = parseFloat(cs.fontSize);
    if (!(font > 0)) continue;
    var lh = /px$/.test(cs.lineHeight) ? parseFloat(cs.lineHeight) : null;
    sizes.push([els[j], font * F, lh === null ? null : lh * F]);
  }
  for (var k = 0; k < sizes.length; k++) {
    var s = sizes[k];
    s[0].style.setProperty('font-size', Math.round(s[1] * 100) / 100 + 'px', 'important');
    if (s[2] !== null) s[0].style.setProperty('line-height', Math.round(s[2] * 100) / 100 + 'px', 'important');
  }
  if (window.__rnReport) setTimeout(window.__rnReport, 0);
})();
true;
`;
}
