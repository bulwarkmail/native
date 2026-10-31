import { normalizeBottomQuickActions, type QuickAction, type SwipeAction } from '../stores/settings-store';

// The organisation's archiveActionEnabled gate (webmail
// message-list-settings.tsx): with it off, Archive is no swipe action, no
// row action and no quick action, and a stored one does nothing.

/** What a swipe does: a stored Archive swipe does nothing while archiving is off. */
export function swipeActionShown(action: SwipeAction, archiveEnabled: boolean): SwipeAction {
  return !archiveEnabled && action === 'archive' ? 'none' : action;
}

/** The actions a picker offers: without Archive while archiving is off. */
export function withoutArchive<T extends { value: string }>(options: readonly T[], archiveEnabled: boolean): T[] {
  return archiveEnabled ? [...options] : options.filter((option) => option.value !== 'archive');
}

/**
 * The reader's three quick actions: a stored Archive slot gives way to a
 * reply action while archiving is off, so the bar keeps three buttons.
 */
export function bottomQuickActionsFor(value: unknown, archiveEnabled: boolean): QuickAction[] {
  const actions = normalizeBottomQuickActions(value);
  return archiveEnabled ? actions : normalizeBottomQuickActions(actions.filter((action) => action !== 'archive'));
}
