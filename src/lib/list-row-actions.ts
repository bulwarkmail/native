import type { SwipeAction } from '../stores/settings-store';

export interface RowAccessibilityAction {
  name: string;
  label: string;
}

export type ParsedRowAction =
  | { kind: 'swipe'; action: SwipeAction }
  | { kind: 'code' }
  | { kind: 'attachment'; index: number }
  | { kind: 'select' };

export interface RowActionInput {
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
  /** The label SwipeableRow shows for an action in this row's state. */
  swipeLabel: (action: SwipeAction) => string;
  /** Present when the row shows a verification-code chip. */
  copyCodeLabel?: string;
  /** Names of the chips the row shows, in order. */
  attachmentNames: readonly string[];
  /** Builds "Open attachment: {name}". */
  openAttachmentLabel: (name: string) => string;
  selectLabel: string;
}

/**
 * The custom screen-reader actions of a list row. Its label makes the row one
 * accessible element, which hides the swipe bands and the chips inside it, so
 * everything they do is offered as an action instead.
 */
export function buildRowActions(i: RowActionInput): RowAccessibilityAction[] {
  const out: RowAccessibilityAction[] = [];
  const seen = new Set<SwipeAction>();
  for (const action of [i.swipeLeft, i.swipeRight]) {
    if (action === 'none' || seen.has(action)) continue;
    seen.add(action);
    out.push({ name: `swipe:${action}`, label: i.swipeLabel(action) });
  }
  if (i.copyCodeLabel) out.push({ name: 'code', label: i.copyCodeLabel });
  i.attachmentNames.forEach((name, index) => {
    out.push({ name: `attachment:${index}`, label: i.openAttachmentLabel(name) });
  });
  out.push({ name: 'select', label: i.selectLabel });
  return out;
}

export function parseRowAction(name: string): ParsedRowAction | null {
  if (name === 'code') return { kind: 'code' };
  if (name === 'select') return { kind: 'select' };
  if (name.startsWith('swipe:')) return { kind: 'swipe', action: name.slice(6) as SwipeAction };
  if (name.startsWith('attachment:')) {
    const index = Number(name.slice(11));
    return Number.isInteger(index) && index >= 0 ? { kind: 'attachment', index } : null;
  }
  return null;
}
