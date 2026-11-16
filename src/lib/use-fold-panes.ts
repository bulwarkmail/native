import { useWindowDimensions } from 'react-native';
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
