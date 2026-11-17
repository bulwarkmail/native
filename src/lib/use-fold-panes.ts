import React from 'react';
import { Keyboard, Platform, TextInput, useWindowDimensions, type View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHalfOpen } from './device-hinge';
import { TAB_RAIL_WIDTH, foldAlignedPanes, laptopFoldY, layoutFor, tabBarPositionFor } from './use-layout';

/**
 * The list's width in a tab's list-detail split (Contacts, Settings) on an
 * iPhone Duo half open like a book: the list ends at the fold, as the Mail
 * tab's does (`foldAlignedPanes`), while both panes keep their minimum
 * widths. Anywhere else, `listWidth` as it is. `room` is the width the list
 * and the detail share. Not for Files: its docked preview needs 440 pt for
 * its header, more than the Duo's fold leaves it (391).
 */
export function useFoldAlignedListWidth(listWidth: number, room: number): number {
  const halfOpen = useHalfOpen();
  const { width, height } = useWindowDimensions();
  const { top, left, right } = useSafeAreaInsets();
  if (!halfOpen || width <= height) return listWidth;
  const window = layoutFor(width, height);
  const rail = tabBarPositionFor(window, width, { top, left, right }) === 'left' ? TAB_RAIL_WIDTH : 0;
  const split = { ...window, isSplit: true, listWidth, detailWidth: room - listWidth };
  return foldAlignedPanes(split, width, left + rail).listWidth;
}

/**
 * Where the fold crosses the window of an iPhone Duo half open like a laptop
 * (`laptopFoldY`), else null. A tab's list-detail split stacks there instead:
 * the detail over the top of the row down to the fold, the list below it.
 */
export function useLaptopFoldY(): number | null {
  const halfOpen = useHalfOpen();
  const { width, height } = useWindowDimensions();
  return laptopFoldY(halfOpen, width, height);
}

/**
 * Whether the keyboard is up for a field of the list (`listRef`: the view
 * that holds it) in a stacked layout (`foldY`). On an iPhone Duo half open
 * like a laptop the keyboard covers most of the half lying flat, the list's
 * search field with it, so the list then takes the whole screen until the
 * keyboard goes. Only a field inside the list counts: not the reader's quick
 * reply above the fold, nor a dialog or another screen over the tab.
 */
export function useTypingInList(foldY: number | null, listRef: React.RefObject<View | null>): boolean {
  const [typing, setTyping] = React.useState(false);
  React.useEffect(() => {
    if (foldY == null) {
      setTyping(false);
      return undefined;
    }
    const check = () => {
      const field = TextInput.State.currentlyFocusedInput();
      const list = listRef.current;
      if (!field || !list) return;
      // Succeeds only for a descendant of the list.
      field.measureLayout(list, () => setTyping(true), () => undefined);
    };
    // Already up when the layout stacks (a file opened from a search, the phone half closed while typing).
    if (Keyboard.isVisible()) check();
    const shown = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', check);
    const hidden = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setTyping(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [foldY, listRef]);
  return foldY != null && typing;
}
