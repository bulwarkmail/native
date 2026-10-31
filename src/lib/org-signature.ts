/**
 * The organisation signature and disclaimer (policy `organisation.signature`
 * and `organisation.disclaimer`). Port of the webmail's lib/org-signature.ts,
 * lib/org/signature-state.ts (orgSignatureSetup), lib/org/body-match.ts and
 * lib/org/outgoing.ts, without a DOM: HTML is handled as strings through a
 * small tree parser.
 *
 * - The templates are filled in per sending identity with its name and
 *   address, the company name and the details each user fills in once
 *   (title, department, phone, mobile). Values go in as text, HTML-escaped
 *   in the HTML template (attributes included). A line whose placeholders
 *   are all empty is dropped; a table row counts as one line.
 * - Which signature the composer inserts (effectiveSignatureIdentity): with
 *   no restriction, the organisation signature stands in for an identity
 *   without a signature of its own; with `signature` locked or hidden it
 *   replaces every identity's.
 * - On send (never on a draft): a locked organisation signature the user
 *   deleted is appended again once, and the disclaimer goes below
 *   everything, quote included (`<hr>` and the HTML in the HTML part, a
 *   blank line and the text in the text part). A part that already carries
 *   it keeps the one it has.
 */

import type { OrgPolicy, SettingRestriction } from './org-policy';
import { appendHtmlSignature, appendPlainTextSignature, getPlainTextSignature, sanitizeSignatureHtml, SIGNATURE_RANGE_MARKER } from './signature-utils';
import { extractUserAuthoredText, htmlToPlainText, QUOTED_BLOCK_ATTR } from './compose-html';

export const SIGNATURE_FIELDS = ['title', 'department', 'phone', 'mobile'] as const;
export type SignatureField = (typeof SIGNATURE_FIELDS)[number];
export type SignatureDetails = Record<SignatureField, string>;

export const SIGNATURE_PLACEHOLDERS = [
  'name', 'email', 'identity', 'company', 'domain', 'title', 'department', 'phone', 'mobile',
] as const;
export type SignaturePlaceholder = (typeof SIGNATURE_PLACEHOLDERS)[number];
export type SignatureValues = Partial<Record<SignaturePlaceholder, string>>;

export interface FilledSignature {
  html: string;
  text: string;
}

interface Template {
  html: string;
  text: string;
}

const MAX_TEXT = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function templateOf(raw: unknown): Template {
  const section = isRecord(raw) ? raw : {};
  const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, MAX_TEXT) : '');
  return { html: text(section.html), text: text(section.text) };
}

/** The signature and disclaimer templates of a policy's organisation part (webmail sanitizeOrganisationPartial). */
export function organisationTemplates(organisation: unknown): { signature: Template; disclaimer: Template } {
  const org = isRecord(organisation) ? organisation : {};
  return { signature: templateOf(org.signature), disclaimer: templateOf(org.disclaimer) };
}

const PLACEHOLDER_RE = /\{(name|email|identity|company|domain|title|department|phone|mobile)\}/g;

/** The placeholders a template uses, each once, in the order they appear. */
export function placeholdersIn(template: string): SignaturePlaceholder[] {
  const found = new Set<SignaturePlaceholder>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) found.add(match[1] as SignaturePlaceholder);
  return [...found];
}

const valueOf = (values: SignatureValues, key: string) => (values[key as SignaturePlaceholder] ?? '').trim();

function fillString(template: string, values: SignatureValues, escape: (value: string) => string = (v) => v): string {
  return template.replace(PLACEHOLDER_RE, (_, key: string) => escape(valueOf(values, key)));
}

function allPlaceholdersEmpty(keys: string[], values: SignatureValues): boolean {
  return keys.length > 0 && keys.every((key) => !valueOf(values, key));
}

/** Fills a plain-text template; lines whose placeholders are all empty are dropped. */
export function fillTextTemplate(template: string, values: SignatureValues): string {
  return template
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !allPlaceholdersEmpty(placeholdersIn(line), values))
    .map((line) => fillString(line, values))
    .join('\n')
    .trim();
}

// ─── A small HTML tree (no DOM in React Native) ─────────────────────────

interface TextNode { type: 'text'; text: string; parent: El | null }
interface RawNode { type: 'raw'; text: string; parent: El | null }
interface Attr { name: string; value: string }
interface El { type: 'el'; tag: string; attrs: Attr[]; children: TreeNode[]; parent: El | null }
type TreeNode = TextNode | RawNode | El;

const VOID_TAGS = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'SOURCE', 'TRACK', 'WBR']);
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CENTER', 'DD', 'DIV', 'DL', 'DT', 'FOOTER', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH',
  'THEAD', 'TR', 'UL',
]);
/** Content that shows without text: kept when its line's placeholders are empty. */
const MEDIA_TAGS = new Set(['IMG', 'SVG', 'PICTURE', 'VIDEO']);
const VISIBLE_TAGS = new Set(['IMG', 'HR', 'SVG', 'PICTURE', 'VIDEO']);

const TOKEN_RE = /<!--[\s\S]*?-->|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>|[^<]+|</g;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(raw: string): Attr[] {
  const attrs: Attr[] = [];
  for (const m of raw.matchAll(ATTR_RE)) attrs.push({ name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? '' });
  return attrs;
}

function parseHtml(html: string): El {
  const root: El = { type: 'el', tag: 'BODY', attrs: [], children: [], parent: null };
  let current = root;
  for (const m of html.matchAll(TOKEN_RE)) {
    const token = m[0];
    if (token.startsWith('<!--')) {
      current.children.push({ type: 'raw', text: token, parent: current });
    } else if (m[1]) {
      const tag = m[1].toUpperCase();
      let open: El | null = current;
      while (open && open !== root && open.tag !== tag) open = open.parent;
      if (open && open !== root) current = open.parent ?? root;
    } else if (m[2]) {
      const el: El = { type: 'el', tag: m[2].toUpperCase(), attrs: parseAttrs(m[3] ?? ''), children: [], parent: current };
      current.children.push(el);
      if (!VOID_TAGS.has(el.tag) && !/\/\s*>$/.test(token)) current = el;
    } else {
      current.children.push({ type: 'text', text: token, parent: current });
    }
  }
  return root;
}

// Attribute values are kept as written; filled-in values are escaped as they go in.
const escapeAttr = (value: string) => value.replace(/"/g, '&quot;');
const escapeAttrValue = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function serialize(nodes: TreeNode[]): string {
  return nodes.map((node) => {
    if (node.type !== 'el') return node.text;
    const tag = node.tag.toLowerCase();
    const attrs = node.attrs.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('');
    return VOID_TAGS.has(node.tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${serialize(node.children)}</${tag}>`;
  }).join('');
}

const elementChildren = (el: El) => el.children.filter((child): child is El => child.type === 'el');

function textContent(node: TreeNode): string {
  if (node.type === 'text') return node.text;
  if (node.type === 'raw') return '';
  return node.children.map(textContent).join('');
}

function hasDescendant(el: El, test: (child: El) => boolean): boolean {
  return elementChildren(el).some((child) => test(child) || hasDescendant(child, test));
}

function removeNode(node: TreeNode): void {
  const parent = node.parent;
  if (!parent) return;
  const index = parent.children.indexOf(node);
  if (index >= 0) parent.children.splice(index, 1);
  node.parent = null;
}

const hasVisibleContent = (el: El) =>
  textContent(el).replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').trim().length > 0 || hasDescendant(el, (child) => VISIBLE_TAGS.has(child.tag));

function placeholdersOfNodes(nodes: TreeNode[]): string[] {
  const keys: string[] = [];
  const visit = (node: TreeNode) => {
    if (node.type === 'text') {
      keys.push(...placeholdersIn(node.text));
      return;
    }
    if (node.type !== 'el') return;
    for (const attr of node.attrs) keys.push(...placeholdersIn(attr.value));
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return keys;
}

interface Line {
  leaves: TreeNode[];
  br: El | null;
  endsAtBlock: boolean;
}

function linesOf(block: El): Line[] {
  const lines: Line[] = [];
  let leaves: TreeNode[] = [];
  const end = (br: El | null, endsAtBlock: boolean) => {
    lines.push({ leaves, br, endsAtBlock });
    leaves = [];
  };
  const walk = (node: TreeNode) => {
    if (node.type === 'text') {
      leaves.push(node);
      return;
    }
    if (node.type !== 'el') return;
    if (BLOCK_TAGS.has(node.tag)) end(null, true);
    else if (node.tag === 'BR') end(node, false);
    else if (MEDIA_TAGS.has(node.tag)) leaves.push(node);
    else node.children.forEach(walk);
  };
  block.children.forEach(walk);
  end(null, false);
  return lines;
}

function placeholdersOfLine(line: Line, block: El): string[] {
  const keys = placeholdersOfNodes(line.leaves);
  const wrappers = new Set<El>();
  for (const leaf of line.leaves) {
    for (let parent = leaf.parent; parent && parent !== block; parent = parent.parent) wrappers.add(parent);
  }
  for (const wrapper of wrappers) {
    for (const attr of wrapper.attrs) keys.push(...placeholdersIn(attr.value));
  }
  return keys;
}

function removeWithEmptyWrappers(node: TreeNode, block: El): void {
  let parent = node.parent;
  removeNode(node);
  while (parent && parent !== block && !hasVisibleContent(parent) && !hasDescendant(parent, (child) => child.tag === 'BR')) {
    const next: El | null = parent.parent;
    removeNode(parent);
    parent = next;
  }
}

function dropEmptyLines(el: El, values: SignatureValues, isRoot: boolean): void {
  if (placeholdersOfNodes([el]).length === 0) return;
  // A table row is one line: "Phone: | {phone}" goes as a whole.
  if (el.tag === 'TR' && allPlaceholdersEmpty(placeholdersOfNodes([el]), values)) {
    removeNode(el);
    return;
  }
  const nested: El[] = [];
  const collect = (node: El) => {
    for (const child of elementChildren(node)) {
      if (BLOCK_TAGS.has(child.tag)) nested.push(child);
      else collect(child);
    }
  };
  collect(el);
  nested.forEach((child) => dropEmptyLines(child, values, false));

  const lines = linesOf(el);
  lines.forEach((line, index) => {
    if (!allPlaceholdersEmpty(placeholdersOfLine(line, el), values)) return;
    let kept = false;
    for (const leaf of line.leaves) {
      const media = leaf.type === 'el' && MEDIA_TAGS.has(leaf.tag);
      if (media && placeholdersOfNodes([leaf]).length === 0) kept = true;
      else removeWithEmptyWrappers(leaf, el);
    }
    if (kept) return;
    if (line.br) {
      removeWithEmptyWrappers(line.br, el);
      return;
    }
    for (let j = index - 1; j >= 0 && !lines[j].endsAtBlock; j--) {
      const previous = lines[j].br;
      if (previous?.parent) {
        removeWithEmptyWrappers(previous, el);
        break;
      }
    }
  });

  if (!isRoot && !hasVisibleContent(el)) removeNode(el);
}

function fillNodes(root: El, values: SignatureValues): void {
  const walk = (node: TreeNode) => {
    if (node.type === 'text') {
      if (placeholdersIn(node.text).length > 0) node.text = fillString(node.text, values, escapeText);
      return;
    }
    if (node.type !== 'el') return;
    for (const attr of node.attrs) {
      if (placeholdersIn(attr.value).length > 0) attr.value = fillString(attr.value, values, escapeAttrValue);
    }
    node.children.forEach(walk);
  };
  root.children.forEach(walk);
}

/**
 * Fills an HTML template. Values go in as text (escaped); lines whose
 * placeholders are all empty are dropped. The result still goes through
 * the signature sanitizer wherever it is inserted.
 */
export function fillHtmlTemplate(template: string, values: SignatureValues): string {
  const root = parseHtml(template);
  dropEmptyLines(root, values, true);
  fillNodes(root, values);
  return serialize(root.children).trim();
}

/** The placeholder values for one identity. */
export function signatureValuesFor(
  identity: { name?: string | null; email?: string | null } | null | undefined,
  details: Partial<SignatureDetails> | null | undefined,
  company: string,
): SignatureValues {
  const email = identity?.email?.trim() ?? '';
  const name = identity?.name?.trim() ?? '';
  const at = email.lastIndexOf('@');
  return {
    name,
    email,
    identity: name && email ? `${name} <${email}>` : name || email,
    company: company.trim(),
    domain: at >= 0 ? email.slice(at + 1).toLowerCase() : '',
    title: details?.title ?? '',
    department: details?.department ?? '',
    phone: details?.phone ?? '',
    mobile: details?.mobile ?? '',
  };
}

/** A template filled in, or null when the admin set none. */
export function buildOrgSignature(template: Template | null | undefined, values: SignatureValues): FilledSignature | null {
  const html = template?.html?.trim() ?? '';
  const text = template?.text?.trim() ?? '';
  if (!html && !text) return null;
  return {
    html: html ? fillHtmlTemplate(html, values) : '',
    text: text ? fillTextTemplate(text, values) : '',
  };
}

export interface SignatureRestriction {
  locked: boolean;
  hidden: boolean;
}

export function signatureRestriction(restriction: SettingRestriction | undefined): SignatureRestriction {
  return { locked: restriction?.locked === true, hidden: restriction?.hidden === true };
}

export const isSignatureEnforced = (r: SignatureRestriction) => r.locked || r.hidden;

export interface OrgSignatureSetup {
  /** Filled for the sending identity; null when the admin set no signature. */
  signature: FilledSignature | null;
  /** The disclaimer, filled the same way; null when the admin set none. */
  disclaimer: FilledSignature | null;
  restriction: SignatureRestriction;
}

/** The organisation signature and disclaimer for mail from `sending` (webmail orgSignatureSetup). */
export function orgSignatureSetup(
  policy: OrgPolicy | null | undefined,
  sending: { name?: string | null; email?: string | null } | null | undefined,
  details: Partial<SignatureDetails> | null | undefined,
  company: string,
): OrgSignatureSetup {
  const templates = organisationTemplates(policy?.organisation);
  const values = signatureValuesFor(sending, details, company);
  return {
    signature: buildOrgSignature(templates.signature, values),
    disclaimer: buildOrgSignature(templates.disclaimer, values),
    restriction: signatureRestriction(policy?.restrictions?.signature),
  };
}

type SignedIdentity = { textSignature?: string; htmlSignature?: string };

const identityHasSignature = (identity: SignedIdentity | null | undefined) =>
  !!(identity?.htmlSignature?.trim() || identity?.textSignature?.trim());

/**
 * The identity whose signature the composer inserts, with the organisation
 * signature applied. `own` is what the composer would sign with on its own
 * (signatureIdentityFor); `sending` is the identity the message goes out
 * from. Returns `own` itself when the organisation signature doesn't apply.
 */
export function effectiveSignatureIdentity<T extends SignedIdentity>(
  own: T | null | undefined,
  sending: T | null | undefined,
  orgSignature: FilledSignature | null,
  restriction: SignatureRestriction,
): T | null | undefined {
  if (!orgSignature) return own;
  if (!isSignatureEnforced(restriction) && identityHasSignature(own)) return own;
  const base = sending ?? own;
  if (!base) return own;
  return { ...base, htmlSignature: orgSignature.html, textSignature: orgSignature.text };
}

// ─── Matching an outgoing body (webmail lib/org/body-match.ts) ──────────

/** The disclaimer's wrapper in the HTML part. */
export const DISCLAIMER_MARKER = 'data-org-disclaimer';

/** Non-empty lines with their whitespace collapsed. */
export function textLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function indexOfLines(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((line, j) => haystack[i + j] === line)) return i;
  }
  return -1;
}

const containsLines = (haystack: string[], needle: string[]) => indexOfLines(haystack, needle) >= 0;

function endsWithLines(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  const start = haystack.length - needle.length;
  return needle.every((line, j) => haystack[start + j] === line);
}

const asSignature = (filled: FilledSignature) => ({ htmlSignature: filled.html, textSignature: filled.text });

/** The lines a filled template shows in an HTML body. */
function htmlLinesOf(filled: FilledSignature): string[] {
  return filled.html.trim() ? textLines(htmlToPlainText(sanitizeSignatureHtml(filled.html))) : textLines(filled.text);
}

/** The lines a filled template shows in a text body. */
function textLinesOf(filled: FilledSignature): string[] {
  return textLines(getPlainTextSignature(asSignature(filled)));
}

/** The body as a tree without its quotes. */
function withoutQuotes(html: string): El {
  const root = parseHtml(html);
  const drop = (el: El) => {
    for (const child of elementChildren(el)) {
      if (child.tag === 'BLOCKQUOTE' || child.attrs.some((a) => a.name === QUOTED_BLOCK_ATTR)) removeNode(child);
      else drop(child);
    }
  };
  drop(root);
  return root;
}

function findAll(el: El, test: (child: El) => boolean, out: El[] = []): El[] {
  for (const child of elementChildren(el)) {
    if (test(child)) out.push(child);
    findAll(child, test, out);
  }
  return out;
}

/**
 * Whether an HTML body carries the signature: the composer's signature
 * block holding it, its lines in the user's part, or its lines at the very
 * end.
 */
export function htmlCarriesSignature(html: string, signature: FilledSignature, forwardedSeparator?: string): boolean {
  const lines = htmlLinesOf(signature);
  if (lines.length === 0) return true;
  const root = withoutQuotes(html);
  const blocks = findAll(root, (el) => el.attrs.some((a) => a.name === SIGNATURE_RANGE_MARKER && a.value === 'body'));
  for (const block of blocks) {
    if (containsLines(textLines(htmlToPlainText(serialize(block.children))), lines)) return true;
  }
  const own = extractUserAuthoredText(html, { plainTextMode: false, forwardedSeparator });
  return containsLines(textLines(own), lines) || endsWithLines(textLines(htmlToPlainText(serialize(root.children))), lines);
}

/** Whether a text body carries the signature, in the user's part or at the very end. */
export function textCarriesSignature(text: string, signature: FilledSignature, forwardedSeparator?: string): boolean {
  const variants = [textLinesOf(signature), htmlLinesOf(signature)].filter((lines) => lines.length > 0);
  if (variants.length === 0) return true;
  const own = textLines(extractUserAuthoredText(text, { plainTextMode: true, forwardedSeparator }));
  const unquoted = textLines(text.split(/\r?\n/).filter((line) => !/^\s*>/.test(line)).join('\n'));
  return variants.some((lines) => containsLines(own, lines) || endsWithLines(unquoted, lines));
}

/** Whether an HTML body already ends with the disclaimer (its wrapper outside the quote, or its lines at the end). */
export function htmlCarriesDisclaimer(html: string, disclaimer: FilledSignature): boolean {
  const root = withoutQuotes(html);
  if (findAll(root, (el) => el.attrs.some((a) => a.name === DISCLAIMER_MARKER)).length > 0) return true;
  return endsWithLines(textLines(htmlToPlainText(serialize(root.children))), htmlLinesOf(disclaimer));
}

/** Whether a text body ends with the disclaimer. */
export function textCarriesDisclaimer(text: string, disclaimer: FilledSignature): boolean {
  const own = textLines(text.split(/\r?\n/).filter((line) => !/^\s*>/.test(line)).join('\n'));
  return endsWithLines(own, textLinesOf(disclaimer)) || endsWithLines(own, htmlLinesOf(disclaimer));
}

// ─── On send (webmail lib/org/outgoing.ts) ───────────────────────────────

export interface OutgoingBodies {
  /** Undefined for a plain-text message. */
  html?: string;
  text: string;
}

/** The disclaimer as it goes into the HTML part. */
export function disclaimerHtml(disclaimer: FilledSignature): string {
  const inner = disclaimer.html.trim()
    ? sanitizeSignatureHtml(disclaimer.html)
    : escapeText(disclaimer.text).replace(/\n/g, '<br>');
  return `<hr><div ${DISCLAIMER_MARKER}="">${inner}</div>`;
}

/**
 * Puts a locked organisation signature back when the user deleted or
 * changed it; adds it once to the part that lacks it.
 */
export function withOrgSignature(
  bodies: OutgoingBodies,
  setup: OrgSignatureSetup,
  options: { separator: boolean; forwardedSeparator?: string },
): OutgoingBodies {
  const signature = setup.signature;
  if (!signature || !isSignatureEnforced(setup.restriction)) return bodies;
  const htmlMissing = bodies.html !== undefined && !htmlCarriesSignature(bodies.html, signature, options.forwardedSeparator);
  // The text part of an HTML message is made from the HTML: what the HTML
  // lacks, it lacks too.
  const textMissing = htmlMissing || !textCarriesSignature(bodies.text, signature, options.forwardedSeparator);
  if (!htmlMissing && !textMissing) return bodies;
  const separator = { separator: options.separator };
  return {
    html: htmlMissing ? appendHtmlSignature(bodies.html!, asSignature(signature), separator) : bodies.html,
    text: textMissing ? appendPlainTextSignature(bodies.text, asSignature(signature), separator) : bodies.text,
  };
}

/** Adds the disclaimer below everything, quote included, unless the part already ends with it. */
export function withOrgDisclaimer(bodies: OutgoingBodies, disclaimer: FilledSignature | null): OutgoingBodies {
  if (!disclaimer) return bodies;
  const text = getPlainTextSignature(asSignature(disclaimer));
  if (!text) return bodies;
  const htmlMissing = bodies.html !== undefined && !htmlCarriesDisclaimer(bodies.html, disclaimer);
  const textMissing = htmlMissing || !textCarriesDisclaimer(bodies.text, disclaimer);
  if (!htmlMissing && !textMissing) return bodies;
  return {
    html: htmlMissing ? `${bodies.html}${disclaimerHtml(disclaimer)}` : bodies.html,
    text: textMissing ? `${bodies.text.replace(/\s+$/, '')}\n\n${text}` : bodies.text,
  };
}

/** Both send-time changes, signature first, the disclaimer last. */
export function finalizeOrgOutgoing(
  bodies: OutgoingBodies,
  setup: OrgSignatureSetup,
  options: { separator: boolean; forwardedSeparator?: string },
): OutgoingBodies {
  return withOrgDisclaimer(withOrgSignature(bodies, setup, options), setup.disclaimer);
}
