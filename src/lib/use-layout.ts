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

/** Narrowest right inset that is a status column, not a rounded corner or a sensor housing. */
const STATUS_COLUMN_MIN = 44;

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
 * width; a split layout gets the webmail's desktop placement, bottom right.
 * Either keeps above the tab bar where the tabs are along the bottom
 * (`tabBarPositionFor`).
 */
export function floatingCardFrame(
  width: number,
  split: boolean,
  insets: { left: number; right: number },
  tabBar: TabBarPosition = split ? 'left' : 'bottom',
): { left: number; right: number; bottom: number } {
  if (split) {
    return {
      left: Math.max(FLOATING_CARD_MARGIN, width - FLOATING_CARD_WIDTH - FLOATING_CARD_MARGIN - insets.right),
      right: FLOATING_CARD_MARGIN + insets.right,
      bottom: tabBar === 'bottom' ? TAB_BAR_CLEARANCE : FLOATING_CARD_MARGIN,
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
