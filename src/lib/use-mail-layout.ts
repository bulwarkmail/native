import type { LayoutChangeEvent } from 'react-native';
import { useSettingsStore } from '../stores/settings-store';
import { mailScreenLayoutFor, usePaneArea, type MailScreenLayout } from './use-layout';

/**
 * The layout of the Mail tab (`tabRail`) or a unified view (a stack screen):
 * the window, the reading pane setting (#93) and the room the reader keeps
 * (#104). `ready` is false on a split window until the settings are read.
 */
export function useMailLayout(tabRail: boolean): MailScreenLayout & {
  /** For the screen's root view (lib/use-layout usePaneArea). */
  onLayout: (e: LayoutChangeEvent) => void;
} {
  const { window, contentWidth, onLayout } = usePaneArea(tabRail);
  const readingPane = useSettingsStore((s) => s.readingPane);
  const hydrated = useSettingsStore((s) => s.hydrated);
  return { ...mailScreenLayoutFor(window, contentWidth, readingPane, hydrated), onLayout };
}
