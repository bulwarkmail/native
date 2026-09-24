// The sandboxed document a message body is shown in, built once per message
// and rendering settings. Sanitising a large newsletter is a noticeable chunk
// of JS time, and the viewer mounts the same body again and again: the page
// beside the open one becomes the open one, a card is collapsed and opened,
// the message is opened a second time. Those reuse the document built before.

import {
  prepareEmailHtml, wrapPlainTextEmail, plainTextToSafeHtml,
  type MessageSpacing, type PlainTextFont,
} from './email-html';
import { collapsePlainTextQuotes, type QuoteCollapseLabels } from './quote-collapse';

export interface BodyDocumentInput {
  /** The message (account and id); the sources below are compared as well. */
  key: string;
  /** The HTML part to render, if any. */
  rawHtml: string | null;
  /** The plain text to render when there is no HTML part. */
  text: string | null;
  /** Shown when there is neither. */
  emptyLabel: string;
  blockRemoteImages: boolean;
  cidMap: Record<string, string>;
  isDark: boolean;
  messageSpacing: MessageSpacing;
  plainTextFont: PlainTextFont;
  quoteLabels: QuoteCollapseLabels;
}

export interface BodyDocument {
  html: string;
  /** Inversion CSS is in effect; the DOM re-invert pass should run. */
  applyInversion: boolean;
  hasNativeDark: boolean;
  /** At least one external resource was neutralised. */
  blockedExternal: boolean;
  isHtml: boolean;
}

/** Build the document (no caching). */
export function buildBodyDocument(input: BodyDocumentInput): BodyDocument {
  const { rawHtml, text, isDark } = input;
  if (rawHtml) {
    const res = prepareEmailHtml(rawHtml, {
      blockRemoteImages: input.blockRemoteImages,
      cidMap: input.cidMap,
      isDark,
      messageSpacing: input.messageSpacing,
    });
    return { ...res, isHtml: true };
  }
  if (!text) {
    const res = prepareEmailHtml(`<em style="color:#71717a">${input.emptyLabel}</em>`, { isDark });
    return { ...res, isHtml: true };
  }
  const safe = collapsePlainTextQuotes(plainTextToSafeHtml(text), input.quoteLabels);
  return {
    html: wrapPlainTextEmail(safe, { isDark, font: input.plainTextFont }),
    applyInversion: false,
    hasNativeDark: false,
    blockedExternal: false,
    isHtml: false,
  };
}

const MAX_DOCUMENTS = 10;
const documents = new Map<string, { input: BodyDocumentInput; doc: BodyDocument }>();

function sameCidMap(a: Record<string, string>, b: Record<string, string>): boolean {
  if (a === b) return true;
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
}

function sameSources(a: BodyDocumentInput, b: BodyDocumentInput): boolean {
  return a.rawHtml === b.rawHtml && a.text === b.text && sameCidMap(a.cidMap, b.cidMap);
}

/**
 * The document for a message body, built at most once per message, body and
 * settings (see the module comment). The same input returns the same object.
 */
export function bodyDocument(input: BodyDocumentInput): BodyDocument {
  const key = JSON.stringify([
    input.key, input.blockRemoteImages, input.isDark, input.messageSpacing, input.plainTextFont,
    input.quoteLabels.show, input.quoteLabels.hide, input.emptyLabel,
  ]);
  const hit = documents.get(key);
  if (hit && sameSources(hit.input, input)) {
    documents.delete(key);
    documents.set(key, hit);
    return hit.doc;
  }
  const doc = buildBodyDocument(input);
  documents.delete(key);
  documents.set(key, { input, doc });
  while (documents.size > MAX_DOCUMENTS) documents.delete(documents.keys().next().value as string);
  return doc;
}

/** Forget every document built (sign-out, account removal). */
export function clearBodyDocuments(): void {
  documents.clear();
}
