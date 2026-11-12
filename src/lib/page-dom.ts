/**
 * Helpers for the scripts the mail view injects into the page
 * (EmailBodyView, quote-collapse, mail-motion, email-dark-mode, mail-reading)
 * and for the compose editor's page, which holds the quoted mail
 * (editor-html), as source to paste into each script's function body.
 *
 * A mail's elements can stand in for names on `document` and `window`: an
 * <img name="body"> is what `document.body` returns, and an element with an
 * id is `window.<id>` until the page sets that property itself. So the
 * scripts read the document's parts through Document.prototype, keep their
 * own values on window as its own properties, and mark a document as done
 * with a symbol, which no element can name. A stand-in document in the unit
 * tests has no Document and is read directly.
 *
 * A <form> is the same for the mail's own elements: <input name="closest">
 * is what `form.closest` returns. So the scripts call methods and read
 * properties of the mail's elements and text through nodeCall and nodePart,
 * which take them from Element.prototype, Node.prototype and the like.
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
  var pageNodeProtoList = null;
  function pageNodeProtos() {
    if (!pageNodeProtoList) {
      var ctors = [
        typeof HTMLElement === 'function' ? HTMLElement : null,
        typeof SVGElement === 'function' ? SVGElement : null,
        typeof Element === 'function' ? Element : null,
        typeof CharacterData === 'function' ? CharacterData : null,
        typeof Node === 'function' ? Node : null,
        typeof EventTarget === 'function' ? EventTarget : null,
      ];
      pageNodeProtoList = [];
      for (var i = 0; i < ctors.length; i++) if (ctors[i] && ctors[i].prototype) pageNodeProtoList.push(ctors[i].prototype);
    }
    return pageNodeProtoList;
  }
  function pageNodeOwn(node, name, kind) {
    var protos = pageNodeProtos();
    for (var i = 0; i < protos.length; i++) {
      var d = Object.getOwnPropertyDescriptor(protos[i], name);
      if (d && d[kind] && Object.prototype.isPrototypeOf.call(protos[i], node)) return d;
    }
    return null;
  }
  function nodePart(node, name) {
    var d = pageNodeOwn(node, name, 'get');
    return d ? d.get.call(node) : node[name];
  }
  function nodeCall(node, name, args) {
    var d = pageNodeOwn(node, name, 'value');
    var fn = d && typeof d.value === 'function' ? d.value : node[name];
    return fn.apply(node, args);
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
