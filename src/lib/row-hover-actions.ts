import type { SwipeAction } from '../stores/settings-store';

// The quick actions a mail row shows under a mouse pointer (a desktop window:
// Samsung DeX, a Chromebook, a tablet with a mouse), as the webmail's rows do
// on hover (components/email/email-hover-actions.tsx). They are a subset of
// the swipe actions, so a list handles them with its swipe handler.

export type RowHoverAction = Extract<SwipeAction, 'delete' | 'star' | 'read' | 'archive'>;

/** The webmail's default set, in its order. */
const ROW_HOVER_ACTIONS: readonly RowHoverAction[] = ['delete', 'star', 'read', 'archive'];

/**
 * The actions to show: without Archive where the list cannot archive (the
 * organisation turned it off, no Archive folder, or the list is Archive).
 */
export function rowHoverActions(canArchive: boolean): RowHoverAction[] {
  return ROW_HOVER_ACTIONS.filter((action) => canArchive || action !== 'archive');
}

/**
 * Whether a pointer event comes from a pointer that can hover. A finger also
 * "enters" a row when it touches it; only a mouse shows the actions.
 */
export function isHoverPointer(pointerType: string | undefined): boolean {
  return pointerType === 'mouse';
}
