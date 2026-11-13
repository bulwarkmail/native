import { create } from 'zustand';
import type { CrossView, UnifiedRole } from '../api/unified-inbox';

/**
 * A unified view (All inboxes, All Sent, All mail, ...): one role across the
 * accounts, or a cross-folder view.
 */
export interface UnifiedViewTarget {
  /** Per-role unified view; the inbox when neither is set. */
  role?: UnifiedRole;
  /** Cross-folder view: every included folder, unread only, starred only. */
  view?: CrossView;
}

// The unified views are lists of the Mail tab, like a folder (#119): the tab
// shows the one named here in place of the folder list, with the tab bar and
// the folder drawer still there. The drawer and the `mail/unified` links set
// it; choosing a folder, a tag or an account clears it.
interface UnifiedViewState {
  target: UnifiedViewTarget | null;
}

export const useUnifiedView = create<UnifiedViewState>(() => ({ target: null }));

export function showUnifiedView(target: UnifiedViewTarget): void {
  useUnifiedView.setState({ target });
}

/** Back to the folder list of the Mail tab. */
export function showMailFolders(): void {
  if (useUnifiedView.getState().target) useUnifiedView.setState({ target: null });
}

/** Whether `target` is the unified view on show (for the drawer's selected row). */
export function isUnifiedViewShown(shown: UnifiedViewTarget | null, target: UnifiedViewTarget): boolean {
  if (!shown) return false;
  if (target.view || shown.view) return target.view === shown.view;
  return (target.role ?? 'inbox') === (shown.role ?? 'inbox');
}
