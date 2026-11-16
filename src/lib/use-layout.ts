import React from 'react';
import { Platform, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ReadingPane } from '../stores/settings-store';

/**
 * Window size classes for the adaptive layouts (docs/ux-audit-2026-10.md,
 * "Adaptive layout plan"). They come from the window, not the device, so
 * split-screen, freeform windows and foldables get the layout that fits.
 */
export type WidthClass = 'compact' | 'medium' | 'expanded';

export const MEDIUM_MIN_WIDTH = 600;
export const EXPANDED_MIN_WIDTH = 840;
/** Below this a window is "short": a phone in landscape. */
export const SHORT_MAX_HEIGHT = 480;

export interface Layout {
  widthClass: WidthClass;
  /** A phone in landscape: compress chrome, keep the single-pane layout. */
  shortHeight: boolean;
  /** List and detail side by side (medium or expanded, and not short). */
  isSplit: boolean;
  /** A persistent sidebar next to the list (expanded and not short). */
  hasSidebar: boolean;
}

export function layoutFor(width: number, height: number): Layout {
  const widthClass: WidthClass =
    width >= EXPANDED_MIN_WIDTH ? 'expanded' : width >= MEDIUM_MIN_WIDTH ? 'medium' : 'compact';
  const shortHeight = height < SHORT_MAX_HEIGHT;
  const isSplit = widthClass !== 'compact' && !shortHeight;
  return { widthClass, shortHeight, isSplit, hasSidebar: isSplit && widthClass === 'expanded' };
}

export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  return layoutFor(width, height);
}

/**
 * Width of the list pane next to a detail pane: a third of the window,
 * between 320 and 420 dp (the webmail's list column is about 400).
 */
export function listPaneWidth(windowWidth: number): number {
  return Math.round(Math.max(320, Math.min(420, windowWidth * 0.34)));
}

/**
 * The tab rail of a split window (App.tsx: icon over label, 12 dp padding on
 * each side). Its width follows the longest tab label; 86 dp is the English
 * one measured on a device (#104).
 */
export const TAB_RAIL_WIDTH = 86;
/** Width of the permanent folder sidebar (SidebarDrawer; the webmail's default sidebar is 256 px). */
export const DOCKED_WIDTH = 272;
/**
 * Narrowest reading pane beside the list: a 360 dp phone, the narrowest
 * screen the reader is laid out for. Below it the message (or the contact
 * in Contacts) is too narrow to read, and the screen keeps one pane.
 */
export const READING_PANE_MIN = 360;
/** The list gives way to the detail pane down to this width. */
export const LIST_PANE_MIN = 280;

/**
 * Width left for a screen's own content, until the screen has measured
 * itself: the window less its side safe-area insets and, on a tab screen
 * beside the tab rail, the rail.
 */
export function contentWidthFor(
  width: number,
  layout: Layout,
  insets: Insets,
  tabScreen: boolean,
): number {
  const rail = tabScreen && tabBarPositionFor(layout, width, insets) === 'left';
  return width - insets.left - insets.right - (rail ? TAB_RAIL_WIDTH : 0);
}

/**
 * Content width from a screen's measured root: a screen beside the tab rail
 * starts right of it (the rail keeps clear of the left inset), any other at
 * the window's edge.
 */
export function measuredContentWidth(
  rootWidth: number,
  besideRail: boolean,
  insets: { left: number; right: number },
): number {
  return rootWidth - insets.right - (besideRail ? 0 : insets.left);
}

/** A list-detail layout with its pane widths. */
export interface PaneLayout extends Layout {
  /** The list column: the whole content width on one pane. */
  listWidth: number;
  /** The detail pane next to the list, 0 on one pane. */
  detailWidth: number;
}

function listWidthBeside(available: number): number {
  return Math.max(LIST_PANE_MIN, Math.min(listPaneWidth(available), available - READING_PANE_MIN));
}

/**
 * List and detail for a content area `contentWidth` wide (#104). The window
 * class only allows the split and the docked sidebar; they are used when the
 * detail pane keeps READING_PANE_MIN. The list shrinks towards LIST_PANE_MIN
 * first, as the Files list does (lib/files-split), then the sidebar goes back
 * into its drawer, and below that the screen keeps one pane, as on a phone.
 */
export function paneLayoutFor(layout: Layout, contentWidth: number): PaneLayout {
  if (layout.isSplit) {
    for (const sidebar of layout.hasSidebar ? [true, false] : [false]) {
      const available = contentWidth - (sidebar ? DOCKED_WIDTH : 0);
      const listWidth = listWidthBeside(available);
      if (available - listWidth >= READING_PANE_MIN) {
        return { ...layout, hasSidebar: sidebar, listWidth, detailWidth: available - listWidth };
      }
    }
  }
  return { ...layout, isSplit: false, hasSidebar: false, listWidth: contentWidth, detailWidth: 0 };
}

/**
 * Where the tabs are: a bar along the bottom, a rail down the left, or the
 * status column down the right (`SideColumnTabBar`).
 */
export type TabBarPosition = 'bottom' | 'left' | 'right';

type Insets = { top: number; left: number; right: number };

/**
 * Narrowest right inset that is a status column (the Duo's is 84 pt), not a
 * rounded corner or a sensor housing; also the least the column's tabs
 * (SideColumnTabBar) are laid out for.
 */
const STATUS_COLUMN_MIN = 64;

/**
 * Whether iOS keeps the status bar in a column down the right edge of the
 * window, as the iPhone Duo does on its outer display and on its inner one
 * turned sideways: that column is the window's right safe-area inset, with
 * none at the top or on the left. An iPhone in landscape has an inset on
 * both sides.
 */
export function hasStatusColumn(insets: Insets, os: string = Platform.OS): boolean {
  return os === 'ios' && insets.right >= STATUS_COLUMN_MIN && insets.left === 0 && insets.top === 0;
}

/** A button in the status column (StatusColumnBar), and the gap between its two groups. */
export const STATUS_COLUMN_BUTTON = 40;
const STATUS_COLUMN_GAP = 16;
/**
 * The top of the status column that the status bar keeps: the clock and the
 * battery end about 146 pt down on the iPhone Duo's outer display.
 */
const STATUS_BAR_RESERVE = 150;

/**
 * Whether `buttons` toolbar buttons fit in the status column (`hasStatusColumn`)
 * of a window `height` tall, below the status bar and above the bottom inset.
 * The Duo's eleven message buttons fit on both displays (678 and 669 pt).
 */
export function fitsStatusColumn(
  insets: Insets & { bottom: number },
  height: number,
  buttons: number,
  os: string = Platform.OS,
): boolean {
  return hasStatusColumn(insets, os)
    && STATUS_BAR_RESERVE + buttons * STATUS_COLUMN_BUTTON + STATUS_COLUMN_GAP + insets.bottom + 8 <= height;
}

/** `fitsStatusColumn` for the current window: whether a stack screen's `buttons` toolbar buttons go into the status column. */
export function useFitsStatusColumn(buttons: number): boolean {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return fitsStatusColumn(insets, height, buttons);
}

/**
 * Where a window's tabs go. Where iOS keeps the status bar in a column on the
 * side (`hasStatusColumn`), the tabs go in that column, as Apple lays out
 * the iPhone Duo's bars. Otherwise a split window puts them in a rail on the
 * left, like the webmail's navigation rail, unless the rail's width is all
 * that keeps the list and the reader from fitting side by side: there the
 * tabs stay a bar along the bottom and the window gets both panes. That is a
 * window 640 to 725 dp wide, such as the iPhone Duo's inner display held
 * upright (669 pt), where Apple keeps the bars horizontal and Mail shows the
 * list and the message side by side.
 */
export function tabBarPositionFor(
  layout: Layout,
  width: number,
  insets: Insets,
  os: string = Platform.OS,
): TabBarPosition {
  if (hasStatusColumn(insets, os)) return 'right';
  if (!layout.isSplit) return 'bottom';
  const content = width - insets.left - insets.right;
  const railCostsTheSplit = paneLayoutFor(layout, content).isSplit
    && !paneLayoutFor(layout, content - TAB_RAIL_WIDTH).isSplit;
  return railCostsTheSplit ? 'bottom' : 'left';
}

/** `tabBarPositionFor` the current window. */
export function useTabBarPosition(): TabBarPosition {
  const { width, height } = useWindowDimensions();
  const { top, left, right } = useSafeAreaInsets();
  return tabBarPositionFor(layoutFor(width, height), width, { top, left, right });
}

/**
 * Panes that meet at the fold of an iPhone Duo held half open like a book:
 * Apple's split views move their column edge to the fold, so neither pane is
 * creased ("Designing for iPhone Duo", Reserved regions). The list ends at
 * the window's centre line, where the hinge is (`listLeft`: where the list
 * starts in the window), as long as both panes keep their minimum widths.
 */
export function foldAlignedPanes(layout: PaneLayout, windowWidth: number, listLeft: number): PaneLayout {
  if (!layout.isSplit) return layout;
  const room = layout.listWidth + layout.detailWidth;
  const listWidth = Math.round(windowWidth / 2) - listLeft;
  if (listWidth < LIST_PANE_MIN || room - listWidth < READING_PANE_MIN) return layout;
  return { ...layout, listWidth, detailWidth: room - listWidth };
}

/**
 * Where the fold crosses the window of an iPhone Duo set down half open like
 * a laptop (the inner display upright, the hinge partially open): half way
 * down. Apple asks apps to keep content clear of it, what is read above and
 * the controls below ("Designing for iPhone Duo"). Null in any other pose.
 */
export function laptopFoldY(halfOpen: boolean, width: number, height: number): number | null {
  return halfOpen && height > width ? Math.round(height / 2) : null;
}

/**
 * The layout of the mail list and reader, `contentWidth` dp wide (the window
 * less the tab rail and the side insets). With the reading pane off (#93)
 * they keep the phone's single pane, and the folder list its drawer, at any
 * width. Otherwise the folder list docks, and the list splits, only while
 * the reader keeps READING_PANE_MIN beside them (#104): by the window alone,
 * an 852 dp foldable got the docked sidebar and left the message 174 dp.
 * The rest of the app (tab rail, contacts, files) follows the window.
 */
export function mailLayoutFor(layout: Layout, readingPane: ReadingPane, contentWidth: number): PaneLayout {
  return paneLayoutFor(readingPane === 'off' ? { ...layout, isSplit: false, hasSidebar: false } : layout, contentWidth);
}

/** The mail screens' layout. */
export interface MailScreenLayout extends PaneLayout {
  /**
   * False while the stored reading pane setting is unknown and decides the
   * layout (a split window): the screen draws its background only. Drawing
   * the split first showed it to a user who turned it off and mounted the
   * mail list twice (#93). Where the split doesn't fit the setting changes
   * nothing, so a phone never waits.
   */
  ready: boolean;
}

export function mailScreenLayoutFor(
  window: Layout,
  contentWidth: number,
  readingPane: ReadingPane,
  settingsHydrated: boolean,
): MailScreenLayout {
  const auto = mailLayoutFor(window, 'auto', contentWidth);
  const layout = readingPane === 'auto' ? auto : mailLayoutFor(window, readingPane, contentWidth);
  return { ...layout, ready: settingsHydrated || !auto.isSplit };
}

/** The window's layout and the width a list-detail screen has for its panes. */
export interface PaneArea {
  window: Layout;
  contentWidth: number;
  /** For the screen's root view: replaces the estimate by the measured width. */
  onLayout: (e: LayoutChangeEvent) => void;
}

/**
 * The room of a list-detail screen, a tab screen (`tabScreen`) or a stack
 * screen. The first frames go by an estimate (the rail's width depends on
 * the longest tab label); once the root view has been laid out, by its
 * measured width, until the window changes again.
 */
export function usePaneArea(tabScreen: boolean): PaneArea {
  const { width, height } = useWindowDimensions();
  const { top, left, right } = useSafeAreaInsets();
  const window = layoutFor(width, height);
  const [measured, setMeasured] = React.useState<{ root: number; window: number } | null>(null);
  const onLayout = React.useCallback((e: LayoutChangeEvent) => {
    const root = Math.round(e.nativeEvent.layout.width);
    setMeasured((m) => (m && m.root === root && m.window === width ? m : { root, window: width }));
  }, [width]);
  const insets = { top, left, right };
  const besideRail = tabScreen && tabBarPositionFor(window, width, insets) === 'left';
  const contentWidth = measured && measured.window === width
    ? measuredContentWidth(measured.root, besideRail, insets)
    : contentWidthFor(width, window, insets, tabScreen);
  return { window, contentWidth, onLayout };
}

/** Width for sheets, dialogs and floating cards that would span a wide window. */
export const SHEET_MAX_WIDTH = 560;

/**
 * Left and right offsets of a bottom sheet: centred at SHEET_MAX_WIDTH on a
 * window 600 dp or wider (a phone in landscape included), else full width
 * inside the side safe-area insets (a landscape notch or navigation bar).
 */
export function sheetSideInsets(
  width: number,
  insetLeft: number,
  insetRight: number,
): { left: number; right: number } {
  if (width >= MEDIUM_MIN_WIDTH) {
    const side = Math.max(Math.round((width - SHEET_MAX_WIDTH) / 2), insetLeft, insetRight);
    return { left: side, right: side };
  }
  return { left: insetLeft, right: insetRight };
}

/** `sheetSideInsets` for the current window. */
export function useSheetInsets(): { left: number; right: number } {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { left, right } = sheetSideInsets(width, insets.left, insets.right);
  return React.useMemo(() => ({ left, right }), [left, right]);
}

/** APP.md toast card: 360 wide, 20 from the edges on a large screen. */
const FLOATING_CARD_WIDTH = 360;
const FLOATING_CARD_MARGIN = 20;
/** Phone: full width with 12 dp margins, above the 64 dp tab bar. */
const PHONE_CARD_MARGIN = 12;
const TAB_BAR_CLEARANCE = 64;

/**
 * Where toasts, the undo bar and the push prompt float. A phone gets the full
 * width, above the tab bar where the tabs are along the bottom
 * (`tabBarPositionFor`); a split layout with the tabs on the side gets the
 * webmail's desktop placement, bottom right. A split layout that keeps the
 * bottom bar is laid out like a phone: its list is too narrow for a 360 dp
 * card beside it.
 */
export function floatingCardFrame(
  width: number,
  split: boolean,
  insets: { left: number; right: number },
  tabBar: TabBarPosition = split ? 'left' : 'bottom',
): { left: number; right: number; bottom: number } {
  if (split && tabBar !== 'bottom') {
    return {
      left: Math.max(FLOATING_CARD_MARGIN, width - FLOATING_CARD_WIDTH - FLOATING_CARD_MARGIN - insets.right),
      right: FLOATING_CARD_MARGIN + insets.right,
      bottom: FLOATING_CARD_MARGIN,
    };
  }
  return {
    left: PHONE_CARD_MARGIN + insets.left,
    right: PHONE_CARD_MARGIN + insets.right,
    bottom: tabBar === 'bottom' ? TAB_BAR_CLEARANCE : PHONE_CARD_MARGIN,
  };
}

/** `floatingCardFrame` for the current window; `bottom` excludes the safe-area inset. */
export function useFloatingCardFrame(): { left: number; right: number; bottom: number } {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const layout = layoutFor(width, height);
  const { left, right, bottom } = floatingCardFrame(
    width, layout.isSplit, insets, tabBarPositionFor(layout, width, insets),
  );
  return React.useMemo(() => ({ left, right, bottom }), [left, right, bottom]);
}
