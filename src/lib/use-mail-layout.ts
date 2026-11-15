import { useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettingsStore } from '../stores/settings-store';
import { useHalfOpen } from './device-hinge';
import {
  DOCKED_WIDTH, TAB_RAIL_WIDTH, foldAlignedPanes, mailScreenLayoutFor, tabBarPositionFor, usePaneArea,
  type MailScreenLayout,
} from './use-layout';

/**
 * The layout of the Mail tab (`tabScreen`) or a unified view (a stack screen):
 * the window, the reading pane setting (#93) and the room the reader keeps
 * (#104). `ready` is false on a split window until the settings are read. On
 * an iPhone Duo half open like a book, the Mail tab's panes meet at the fold.
 */
export function useMailLayout(tabScreen: boolean): MailScreenLayout & {
  /** For the screen's root view (lib/use-layout usePaneArea). */
  onLayout: (e: LayoutChangeEvent) => void;
} {
  const { window, contentWidth, onLayout } = usePaneArea(tabScreen);
  const readingPane = useSettingsStore((s) => s.readingPane);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const halfOpen = useHalfOpen();
  const { width, height } = useWindowDimensions();
  const { top, left, right } = useSafeAreaInsets();
  const layout = mailScreenLayoutFor(window, contentWidth, readingPane, hydrated);
  if (!tabScreen || !halfOpen || width <= height) return { ...layout, onLayout };
  const rail = tabBarPositionFor(window, width, { top, left, right }) === 'left' ? TAB_RAIL_WIDTH : 0;
  const listLeft = left + rail + (layout.hasSidebar ? DOCKED_WIDTH : 0);
  return { ...layout, ...foldAlignedPanes(layout, width, listLeft), onLayout };
}
