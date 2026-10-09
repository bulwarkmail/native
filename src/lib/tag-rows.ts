/**
 * The tag rows the drawer and the tag sheet list: the tag tree flattened in
 * tree order, each row with its depth for indenting. The drawer also applies
 * each tag's visibility, as the webmail's sidebar does (isTagVisible in
 * components/layout/sidebar.tsx); the tag sheet lists every tag, since a
 * hidden tag can still be set on mail.
 * Kept free of stores (type imports only) so it stays pure.
 */
import type { KeywordDef } from '../stores/keywords-store';
import {
  buildKeywordTree,
  countKeywordNodes,
  filterKeywordTree,
  keywordVisibility,
  type KeywordNode,
} from './keyword-nesting';

export interface TagRow {
  def: KeywordDef;
  depth: number;
  /** Whether the row has visible tags below it, so it shows a chevron. */
  hasChildren: boolean;
  /** Whether those tags are listed; false for a parent collapsed in the drawer. */
  expanded: boolean;
}

export interface TagRowsOptions {
  /** The nestedTags setting: off, every tag is a top-level row. */
  nested: boolean;
  /** Unset for the tag sheet, which lists every tag; the rest is the drawer's. */
  applyVisibility?: boolean;
  /** Unread counts by tag id; a tag missing here has no count yet. */
  counts?: Record<string, { unread: number } | undefined>;
  /** The tag whose view is open, shown whatever its visibility. */
  selectedId?: string | null;
  /** The drawer's "Show all", which overrides every visibility. */
  showAll?: boolean;
  /**
   * Parents the drawer has collapsed: their tags below are left out, except
   * on the way down to `selectedId`, so the open tag view keeps its row.
   */
  collapsed?: ReadonlySet<string>;
}

export function tagRows(
  defs: KeywordDef[],
  opts: TagRowsOptions,
): { rows: TagRow[]; hiddenCount: number } {
  // The tree nodes are copies, so each row maps back to the stored entry.
  // Duplicate ids keep the first entry, as the tree does.
  const byId = new Map<string, KeywordDef>();
  for (const def of defs) if (!byId.has(def.id)) byId.set(def.id, def);

  const tree: KeywordNode[] = opts.nested
    ? buildKeywordTree(defs)
    : [...byId.values()].map((def) => ({ ...def, children: [], depth: 0 }));

  // Counts come from a separate round trip, so a tag with none yet shows
  // rather than blinking out and back; one the server answered for with no
  // unread mail hides, which is the point of the setting.
  const isVisible = (node: KeywordNode): boolean => {
    if (!opts.applyVisibility || opts.showAll || node.id === opts.selectedId) return true;
    const visibility = keywordVisibility(node);
    if (visibility === 'hide') return false;
    if (visibility === 'unread') {
      const count = opts.counts?.[node.id];
      return !count || count.unread > 0;
    }
    return true;
  };
  const visible = filterKeywordTree(tree, isVisible);

  const onSelectedPath = (node: KeywordNode): boolean =>
    node.id === opts.selectedId || node.children.some(onSelectedPath);

  const rows: TagRow[] = [];
  const walk = (nodes: KeywordNode[]) => {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      // `expanded` is what is stored, so the chevron shows it and a tap
      // opens the branch; a collapsed branch still lists the one child on the
      // way down to the open tag view, and none of its siblings.
      const expanded = !hasChildren || !opts.collapsed?.has(node.id);
      const def = byId.get(node.id);
      if (def) rows.push({ def, depth: node.depth, hasChildren, expanded });
      walk(expanded ? node.children : node.children.filter(onSelectedPath));
    }
  };
  walk(visible);

  return { rows, hiddenCount: countKeywordNodes(tree) - countKeywordNodes(visible) };
}
