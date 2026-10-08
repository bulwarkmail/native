/**
 * Tag nesting, visibility and order. Ported from the webmail's
 * lib/keyword-nesting.ts, adapted to the native tag list:
 *   - a tag can name its parent with `parentId`, so moving a tag under
 *     another one never changes its id (the `$label:<id>` keyword on mail
 *     stays put, with no migration). An absent `parentId` falls back to the
 *     webmail's id-derived parent (`work/clients` sits under `work`), and
 *     `null` pins a tag to the top level whatever its id says;
 *   - the parent links are stored by hand, so they can loop or point at a
 *     deleted tag. The tree places such a tag at the top level rather than
 *     losing it.
 *
 * RFC 8621 section 4.1.1 allows a keyword of 1-255 characters, so a composed
 * id has to stay within MAX_KEYWORD_ID_LENGTH once `$label:` is spent.
 * Kept free of stores (type imports only) so it stays pure.
 */
import type { KeywordDef } from '../stores/keywords-store';
import { KEYWORD_PREFIX } from './thread-utils';

/** Separates parent from child inside a webmail-style tag id. */
export const KEYWORD_SEPARATOR = '/';

/** Longest keyword a JMAP server has to accept (RFC 8621, section 4.1.1). */
export const MAX_KEYWORD_LENGTH = 255;

/** What is left for the id once the `$label:` prefix is spent. */
export const MAX_KEYWORD_ID_LENGTH = MAX_KEYWORD_LENGTH - KEYWORD_PREFIX.length;

/** Where a tag shows in the drawer: always, only while it has unread mail, or never. */
export type KeywordVisibility = 'show' | 'unread' | 'hide';

export const KEYWORD_VISIBILITIES: readonly KeywordVisibility[] = ['show', 'unread', 'hide'];

/** A tag definition placed in the tree. */
export type KeywordNode = KeywordDef & { children: KeywordNode[]; depth: number };

/** A tag without a visibility predates the setting, so it shows. */
export function keywordVisibility(def: KeywordDef): KeywordVisibility {
  return def.visibility ?? 'show';
}

/**
 * Reduces a display name to one level of an id: lowercase, and everything
 * outside `[a-z0-9_-]` folded to a single dash. A slash typed into the name
 * is part of the name, not a level. The only slug function for tag ids.
 */
export function normalizeKeywordLevel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The id a new tag named `name` gets under `parentId` (null = top level).
 * Never shortened: an id over MAX_KEYWORD_ID_LENGTH is for the form to
 * refuse, since a cut id could collide with another tag.
 */
export function composeKeywordId(parentId: string | null, name: string): string {
  const level = normalizeKeywordLevel(name);
  if (!parentId || !level) return level;
  return `${parentId}${KEYWORD_SEPARATOR}${level}`;
}

/** The webmail's parent of a slash id: `work/clients` → `work`. */
function idDerivedParent(id: string): string | null {
  const index = id.lastIndexOf(KEYWORD_SEPARATOR);
  return index <= 0 ? null : id.slice(0, index);
}

/**
 * The tag `def` sits under, or null for the top level. An explicit parent
 * wins over the one the id implies; either only counts when it is defined.
 */
export function effectiveParentId(def: KeywordDef, defined: ReadonlySet<string>): string | null {
  if (def.parentId === null) return null;
  const parent = typeof def.parentId === 'string' ? def.parentId : idDerivedParent(def.id);
  return parent !== null && parent !== def.id && defined.has(parent) ? parent : null;
}

/**
 * Each tag's parent once loops are cut: a tag whose parent chain comes back
 * to itself goes to the top level. Duplicate ids keep the first entry only.
 */
function resolveParents(defs: KeywordDef[]): Map<string, string | null> {
  const defined = new Set(defs.map((d) => d.id));
  const parents = new Map<string, string | null>();
  for (const def of defs) {
    if (!parents.has(def.id)) parents.set(def.id, effectiveParentId(def, defined));
  }
  const looping: string[] = [];
  for (const start of parents.keys()) {
    const seen = new Set<string>();
    let cur = parents.get(start) ?? null;
    while (cur !== null && !seen.has(cur)) {
      if (cur === start) { looping.push(start); break; }
      seen.add(cur);
      cur = parents.get(cur) ?? null;
    }
  }
  for (const id of looping) parents.set(id, null);
  return parents;
}

/**
 * Arranges tag definitions into a tree, keeping the user's order within each
 * level. Every defined tag appears exactly once.
 */
export function buildKeywordTree(defs: KeywordDef[]): KeywordNode[] {
  const parents = resolveParents(defs);
  const nodes = new Map<string, KeywordNode>();
  for (const def of defs) {
    if (!nodes.has(def.id)) nodes.set(def.id, { ...def, children: [], depth: 0 });
  }
  const roots: KeywordNode[] = [];
  for (const node of nodes.values()) {
    const parentId = parents.get(node.id) ?? null;
    const parent = parentId !== null ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const setDepth = (node: KeywordNode, depth: number) => {
    node.depth = depth;
    node.children.forEach((child) => setDepth(child, depth + 1));
  };
  roots.forEach((root) => setDepth(root, 0));
  return roots;
}

/**
 * Prunes a tag tree down to the nodes worth showing. A node survives when the
 * predicate accepts it or when any descendant survives, so hiding a parent
 * never strands the children below it. Depths are left as they were.
 */
export function filterKeywordTree(
  nodes: KeywordNode[],
  isVisible: (node: KeywordNode) => boolean,
): KeywordNode[] {
  const kept: KeywordNode[] = [];
  for (const node of nodes) {
    const children = filterKeywordTree(node.children, isVisible);
    if (children.length > 0 || isVisible(node)) kept.push({ ...node, children });
  }
  return kept;
}

/** Total number of nodes in a tag tree, at every level. */
export function countKeywordNodes(nodes: KeywordNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countKeywordNodes(node.children), 0);
}

/**
 * Every tag below `id`, at any depth, not counting `id` itself. A tag cannot
 * take one of these as its parent without cutting its branch off the tree.
 */
export function descendantIds(defs: KeywordDef[], id: string): Set<string> {
  const parents = resolveParents(defs);
  const below = new Set<string>();
  for (const candidate of parents.keys()) {
    let cur = parents.get(candidate) ?? null;
    while (cur !== null) {
      if (cur === id) { below.add(candidate); break; }
      cur = parents.get(cur) ?? null;
    }
  }
  return below;
}

/**
 * Swaps a tag with the sibling before or after it. With nesting on, a sibling
 * is the nearest entry with the same parent, so a tag never jumps into
 * another branch; with it off, it is the adjacent entry. Returns `defs`
 * itself when there is nothing to swap with.
 */
export function moveKeyword(
  defs: KeywordDef[],
  id: string,
  direction: 'up' | 'down',
  nested: boolean,
): KeywordDef[] {
  const from = defs.findIndex((d) => d.id === id);
  if (from === -1) return defs;
  const step = direction === 'up' ? -1 : 1;
  let to = -1;
  if (nested) {
    const parents = resolveParents(defs);
    const parent = parents.get(id) ?? null;
    for (let i = from + step; i >= 0 && i < defs.length; i += step) {
      if ((parents.get(defs[i].id) ?? null) === parent && defs[i].id !== id) { to = i; break; }
    }
  } else if (from + step >= 0 && from + step < defs.length) {
    to = from + step;
  }
  if (to === -1) return defs;
  const next = [...defs];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
