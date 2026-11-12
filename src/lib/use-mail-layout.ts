import type { LayoutChangeEvent } from 'react-native';
import { useSettingsStore } from '../stores/settings-store';
import { mailLayoutFor, usePaneArea, type PaneLayout } from './use-layout';

/** The mail screens' layout. */
export interface MailScreenLayout extends PaneLayout {
  /**
   * Whether the screen splits by its room alone: false when the window got
   * narrow, true when only the reading pane setting turned the split off.
   */
  windowIsSplit: boolean;
  /** For the screen's root view (lib/use-layout usePaneArea). */
  onLayout: (e: LayoutChangeEvent) => void;
}

/**
 * The layout of the Mail tab (`tabRail`) or a unified view (a stack screen):
 * the window, the reading pane setting (#93) and the room the reader keeps
 * (#104).
 */
export function useMailLayout(tabRail: boolean): MailScreenLayout {
  const { window, contentWidth, onLayout } = usePaneArea(tabRail);
  const readingPane = useSettingsStore((s) => s.readingPane);
  const layout = mailLayoutFor(window, readingPane, contentWidth);
  const windowIsSplit = readingPane === 'off' ? mailLayoutFor(window, 'auto', contentWidth).isSplit : layout.isSplit;
  return { ...layout, windowIsSplit, onLayout };
}
