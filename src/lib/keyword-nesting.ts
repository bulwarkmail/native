import type { KeywordDef, KeywordVisibility } from '../stores/keywords-store';

// Tag nesting and sidebar visibility, ported from the webmail's
// lib/keyword-nesting.ts and lib/keyword-format.ts.
//
// A tag is the JMAP keyword `$label:<id>`. Nesting reuses that single id:
// levels are joined with a slash, so `$label:work/clients` is the child of
// `$label:work`. The hierarchy lives in the keyword itself, so the webmail
// and the app agree on it without sharing their tag lists. Ids are made by
// composeKeywordId (lib/new-tag.ts).

/** Separates parent from child inside a tag id. */
export const KEYWORD_SEPARATOR = '/';

/** A tag definition placed in the hierarchy its id describes. */
export interface KeywordNode extends KeywordDef {
  children: KeywordNode[];
  depth: number;
}

/** Splits `work/clients/acme` into `["work", "clients", "acme"]`. */
export function keywordLevels(id: string): string[] {
  return id.split(KEYWORD_SEPARATOR).filter(Boolean);
}

/** The id of the tag one level up, or null for a top-level tag. */
export function getParentKeywordId(id: string): string | null {
  const index = id.lastIndexOf(KEYWORD_SEPARATOR);
  return index === -1 ? null : id.slice(0, index);
}

/** True when `candidateId` sits anywhere below `ancestorId`. */
export function isKeywordDescendant(candidateId: string, ancestorId: string): boolean {
  return candidateId.startsWith(`${ancestorId}${KEYWORD_SEPARATOR}`);
}

/** True when any defined tag sits below `id`. */
export function hasChildKeywords(id: string, keywords: readonly Pick<KeywordDef, 'id'>[]): boolean {
  return keywords.some((keyword) => isKeywordDescendant(keyword.id, id));
}

/**
 * The tag definitions as the tree their ids describe, keeping the user's
 * order within each level. A tag whose direct parent is not defined stays at
 * the root (callers name such a root in full). With nesting off every tag is
 * its own root, so one code path draws both.
 */
export function buildKeywordTree(keywords: readonly KeywordDef[], nested = true): KeywordNode[] {
  if (!nested) return keywords.map((kw) => ({ ...kw, children: [], depth: 0 }));
  const nodes = new Map<string, KeywordNode>();
  for (const keyword of keywords) nodes.set(keyword.id, { ...keyword, children: [], depth: 0 });

  const roots: KeywordNode[] = [];
  for (const keyword of keywords) {
    const node = nodes.get(keyword.id)!;
    const parentId = getParentKeywordId(keyword.id);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
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
 * Prunes a tag tree to the nodes worth showing. A node stays when the
 * predicate accepts it or any of its descendants stays, so hiding a parent
 * never strands the children below it. Depths stay as they were.
 */
export function filterKeywordTree(
  nodes: readonly KeywordNode[],
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
export function countKeywordNodes(nodes: readonly KeywordNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countKeywordNodes(node.children), 0);
}

/**
 * The rows of a tag tree in drawing order, depth first. Children of a node
 * whose id is not in `expanded` are left out; pass null to show every level.
 */
export function flattenKeywordTree(
  nodes: readonly KeywordNode[],
  expanded: ReadonlySet<string> | null = null,
): KeywordNode[] {
  const out: KeywordNode[] = [];
  const walk = (list: readonly KeywordNode[]) => {
    for (const node of list) {
      out.push(node);
      if (node.children.length > 0 && (expanded === null || expanded.has(node.id))) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * A tag's display name, one entry per level. With nesting off a slash means
 * nothing and the tag is named by its own label. With nesting on each level
 * takes that tag's label, or the raw level when it has no definition.
 */
export function formatKeywordLabels(id: string, keywords: readonly KeywordDef[], nested: boolean): string[] {
  const label = (levelId: string) => keywords.find((keyword) => keyword.id === levelId)?.label;
  if (!nested) return [label(id) ?? id];
  const levels = keywordLevels(id);
  if (levels.length === 0) return [label(id) ?? id];
  return levels.map((level, index) => label(levels.slice(0, index + 1).join(KEYWORD_SEPARATOR)) ?? level);
}

/** `Work/Clients/Acme` for a nested tag, its own name otherwise. */
export function formatKeyword(id: string, keywords: readonly KeywordDef[], nested: boolean): string {
  return formatKeywordLabels(id, keywords, nested).join(KEYWORD_SEPARATOR);
}

/**
 * The label of a row in a tree: a nested row is placed by its indentation and
 * shows its own name; a root spells out its path, which matters when a level
 * above it is not defined here.
 */
export function treeRowLabel(node: KeywordNode, keywords: readonly KeywordDef[], nested: boolean): string {
  return node.depth === 0 ? formatKeyword(node.id, keywords, nested) : node.label;
}

/** Sidebar visibility of a tag, always shown when it was never set. */
export function getKeywordVisibility(keyword: Pick<KeywordDef, 'visibility'>): KeywordVisibility {
  return keyword.visibility ?? 'show';
}

/**
 * Whether a tag row shows in the sidebar (webmail sidebar isTagVisible).
 * "Show if unread" keeps a tag whose count has not arrived yet, rather than
 * blanking it and filling it back in; a count of zero unread hides it. The
 * open tag view and "Show all" always show the tag.
 */
export function isTagVisibleInSidebar(
  keyword: Pick<KeywordDef, 'id' | 'visibility'>,
  counts: Readonly<Record<string, { unread: number } | undefined>>,
  options: { showAll?: boolean; selectedId?: string | null } = {},
): boolean {
  if (options.showAll || keyword.id === options.selectedId) return true;
  const visibility = getKeywordVisibility(keyword);
  if (visibility === 'hide') return false;
  if (visibility === 'unread') {
    const count = counts[keyword.id];
    return !count || count.unread > 0;
  }
  return true;
}

/**
 * The parents a tag being added can go under: every tag, in tree order,
 * named by its full path (webmail KeywordEditForm parentOptions). An edited
 * tag and the tags below it are left out.
 */
export function parentKeywordOptions(
  keywords: readonly KeywordDef[],
  excludeId?: string,
): { id: string; label: string; depth: number }[] {
  return flattenKeywordTree(buildKeywordTree(keywords))
    .filter((node) => !excludeId || (node.id !== excludeId && !isKeywordDescendant(node.id, excludeId)))
    .map((node) => ({ id: node.id, label: formatKeyword(node.id, keywords, true), depth: node.depth }));
}

/** One tag row of the sidebar. */
export interface SidebarTagRow {
  node: KeywordNode;
  label: string;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * The sidebar's tag rows and how many tags the visibility settings keep out
 * of sight (the "Show all (N)" row), as the webmail sidebar builds them:
 * the tree (or a flat list with nesting off), pruned by visibility, with the
 * children of collapsed parents left out.
 */
export function sidebarTagRows(
  keywords: readonly KeywordDef[],
  nested: boolean,
  counts: Readonly<Record<string, { unread: number } | undefined>>,
  options: { showAll?: boolean; selectedId?: string | null; collapsed?: ReadonlySet<string> } = {},
): { rows: SidebarTagRow[]; hiddenCount: number } {
  const tree = buildKeywordTree(keywords, nested);
  const visible = filterKeywordTree(tree, (node) => isTagVisibleInSidebar(node, counts, options));
  const hiddenCount = keywords.length - countKeywordNodes(visible);
  const collapsed = options.collapsed ?? new Set<string>();
  const rows: SidebarTagRow[] = [];
  const walk = (nodes: readonly KeywordNode[]) => {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const expanded = hasChildren && !collapsed.has(node.id);
      rows.push({ node, label: treeRowLabel(node, keywords, nested), hasChildren, expanded });
      if (expanded) walk(node.children);
    }
  };
  walk(visible);
  return { rows, hiddenCount };
}
