import React from 'react';
import { useWindowDimensions } from 'react-native';
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

/** Width of the permanent folder sidebar (the webmail's default sidebar is 256 px). */
export const DOCKED_WIDTH = 272;

/** Narrowest reading pane beside the list: a 360 dp phone, the narrowest screen the reader is laid out for. */
export const READING_PANE_MIN = 360;

/**
 * The layout of the mail list and reader, `width` dp wide (the window less
 * the tab rail). With the reading pane off (#93) they keep the phone's single
 * pane, and the folder list its drawer, at any width. Otherwise the folder
 * list docks, and the list splits, only while the reader keeps
 * READING_PANE_MIN beside them (#104): by the window alone, an 852 dp
 * foldable got the docked sidebar and left the message 174 dp. The rest of
 * the app (tab rail, contacts, files) follows the window.
 */
export function mailLayoutFor(layout: Layout, readingPane: ReadingPane, width: number): Layout {
  if (readingPane === 'off' || !layout.isSplit) return { ...layout, isSplit: false, hasSidebar: false };
  const roomBesideList = (w: number) => w - listPaneWidth(w) >= READING_PANE_MIN;
  return {
    ...layout,
    isSplit: roomBesideList(width),
    hasSidebar: layout.hasSidebar && roomBesideList(width - DOCKED_WIDTH),
  };
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
 * width above the tab bar; a split layout (tabs in a side rail) gets the
 * webmail's desktop placement, bottom right.
 */
export function floatingCardFrame(
  width: number,
  split: boolean,
  insets: { left: number; right: number },
): { left: number; right: number; bottom: number } {
  if (split) {
    return {
      left: Math.max(FLOATING_CARD_MARGIN, width - FLOATING_CARD_WIDTH - FLOATING_CARD_MARGIN - insets.right),
      right: FLOATING_CARD_MARGIN + insets.right,
      bottom: FLOATING_CARD_MARGIN,
    };
  }
  return {
    left: PHONE_CARD_MARGIN + insets.left,
    right: PHONE_CARD_MARGIN + insets.right,
    bottom: TAB_BAR_CLEARANCE,
  };
}

/** `floatingCardFrame` for the current window; `bottom` excludes the safe-area inset. */
export function useFloatingCardFrame(): { left: number; right: number; bottom: number } {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { left, right, bottom } = floatingCardFrame(width, layoutFor(width, height).isSplit, insets);
  return React.useMemo(() => ({ left, right, bottom }), [left, right, bottom]);
}
