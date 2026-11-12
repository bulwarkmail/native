/**
 * Helpers for the scripts the mail view injects into the page
 * (EmailBodyView, quote-collapse, mail-motion, email-dark-mode), as source
 * to paste into each script's function body.
 *
 * A mail's elements can stand in for names on `document` and `window`: an
 * <img name="body"> is what `document.body` returns, and an element with an
 * id is `window.<id>` until the page sets that property itself. So the
 * scripts read the document's parts through Document.prototype, keep their
 * own values on window as its own properties, and mark a document as done
 * with a symbol, which no element can name. A stand-in document in the unit
 * tests has no Document and is read directly.
 */
export const PAGE_DOM_SOURCE = `
  function pagePart(doc, name) {
    try {
      var d = Object.getOwnPropertyDescriptor(Document.prototype, name);
      if (d && d.get) return d.get.call(doc);
    } catch (e) {}
    return doc[name];
  }
  function pageCall(doc, name, args) {
    var fn;
    try { fn = Document.prototype[name]; } catch (e) {}
    if (typeof fn !== 'function') fn = doc[name];
    return fn.apply(doc, args);
  }
  function pageGlobal(win, name) {
    return Object.prototype.hasOwnProperty.call(win, name) ? win[name] : undefined;
  }
  function pageMarked(doc, name) {
    return doc[Symbol.for('bulwark.' + name)] === true;
  }
  function pageOnce(doc, name) {
    if (pageMarked(doc, name)) return false;
    doc[Symbol.for('bulwark.' + name)] = true;
    return true;
  }
`;
