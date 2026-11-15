import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, useWindowDimensions: () => ({ width: 411, height: 914 }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import {
  DOCKED_WIDTH, READING_PANE_MIN, TAB_RAIL_WIDTH, contentWidthFor, floatingCardFrame, layoutFor, listPaneWidth,
  mailLayoutFor, mailScreenLayoutFor, measuredContentWidth, paneLayoutFor, sheetSideInsets, tabBarPositionFor,
  hasStatusColumn, foldAlignedPanes, fitsStatusColumn,
} from '../use-layout';

const NO_INSETS = { top: 0, left: 0, right: 0 };

describe('layoutFor', () => {
  it('keeps a phone in portrait on the single-pane layout', () => {
    expect(layoutFor(411, 914)).toEqual({
      widthClass: 'compact', shortHeight: false, isSplit: false, hasSidebar: false,
    });
  });

  it('keeps a phone in landscape single-pane although it is wide', () => {
    const l = layoutFor(914, 411);
    expect(l.widthClass).toBe('expanded');
    expect(l.shortHeight).toBe(true);
    expect(l.isSplit).toBe(false);
    expect(l.hasSidebar).toBe(false);
  });

  it('splits a tablet in portrait without a sidebar', () => {
    expect(layoutFor(800, 1280)).toEqual({
      widthClass: 'medium', shortHeight: false, isSplit: true, hasSidebar: false,
    });
  });

  it('splits a tablet in landscape and adds the sidebar', () => {
    expect(layoutFor(1280, 800)).toEqual({
      widthClass: 'expanded', shortHeight: false, isSplit: true, hasSidebar: true,
    });
  });

  it('uses the window, so a narrow split-screen window is compact', () => {
    expect(layoutFor(500, 800).isSplit).toBe(false);
  });

  it('puts the breakpoints at 600 and 840', () => {
    expect(layoutFor(599, 900).widthClass).toBe('compact');
    expect(layoutFor(600, 900).widthClass).toBe('medium');
    expect(layoutFor(839, 900).widthClass).toBe('medium');
    expect(layoutFor(840, 900).widthClass).toBe('expanded');
  });
});

describe('mailLayoutFor', () => {
  // The Mail tab's width is the window less the tab rail: 86 dp with the
  // English labels, measured on the emulator.
  const RAIL = 86;
  const mail = (w: number, h: number) => mailLayoutFor(layoutFor(w, h), 'auto', w - RAIL);

  it('keeps the split and the sidebar on a tablet in landscape', () => {
    const tablet = layoutFor(1280, 800);
    expect(mail(1280, 800)).toMatchObject(tablet);
  });

  it('keeps the split without a sidebar on a tablet in portrait', () => {
    expect(mail(800, 1280)).toMatchObject(layoutFor(800, 1280));
  });

  it('drops the docked sidebar where it would leave the reader too narrow (#104)', () => {
    // Pixel 11 Pro Fold, inner screen: 852 dp, so "expanded", but rail,
    // sidebar and list left the message 174 dp.
    const l = mail(852, 883);
    expect(l.isSplit).toBe(true);
    expect(l.hasSidebar).toBe(false);
  });

  it('keeps one pane where the reader would be too narrow beside the list (#104)', () => {
    // Galaxy Z Fold 8, inner screen upright: 616 dp left the message 211 dp.
    expect(mail(616, 816).isSplit).toBe(false);
    // In landscape (816 dp) it keeps the split: 410 dp for the message.
    expect(mail(816, 616).isSplit).toBe(true);
  });

  it('splits from READING_PANE_MIN beside the list, and docks the sidebar from that plus its width', () => {
    const wide = layoutFor(1400, 900);
    expect(READING_PANE_MIN).toBe(360);
    // The list gives way down to 280 dp before the split goes (paneLayoutFor).
    expect(mailLayoutFor(wide, 'auto', 640).isSplit).toBe(true); // 280 + 360
    expect(mailLayoutFor(wide, 'auto', 639).isSplit).toBe(false);
    expect(mailLayoutFor(wide, 'auto', 640 + DOCKED_WIDTH).hasSidebar).toBe(true);
    expect(mailLayoutFor(wide, 'auto', 639 + DOCKED_WIDTH).hasSidebar).toBe(false);
  });

  it('never docks the sidebar on a medium window, whatever the room', () => {
    expect(mailLayoutFor(layoutFor(839, 900), 'auto', 2000).hasSidebar).toBe(false);
  });

  it('keeps the single pane and the folder drawer with the reading pane off (#93)', () => {
    // A wide portrait window, as on an open foldable: the split and the docked sidebar.
    const fold = layoutFor(1280, 1104);
    expect(fold.isSplit).toBe(true);
    expect(fold.hasSidebar).toBe(true);
    expect(mailLayoutFor(fold, 'off', 1280 - RAIL)).toEqual({
      ...fold, isSplit: false, hasSidebar: false, listWidth: 1280 - RAIL, detailWidth: 0,
    });
  });

  it('changes nothing on a phone', () => {
    const phone = layoutFor(411, 914);
    expect(mailLayoutFor(phone, 'auto', 411)).toEqual({ ...phone, listWidth: 411, detailWidth: 0 });
    expect(mailLayoutFor(phone, 'off', 411)).toEqual({ ...phone, listWidth: 411, detailWidth: 0 });
  });
});

// The Mail tab's panes next to the tab rail, for the windows of #104.
function mailTabPanes(width: number, height: number) {
  const window = layoutFor(width, height);
  return mailLayoutFor(window, 'auto', contentWidthFor(width, window, NO_INSETS, true));
}

describe('reading pane width (#104)', () => {
  it('keeps the reader 446 dp on a Pixel Fold inner screen by leaving the folder list in its drawer', () => {
    // 852 dp: rail 86 + sidebar 272 + list 320 left the message 174 dp.
    expect(mailTabPanes(852, 883)).toMatchObject({ isSplit: true, hasSidebar: false, listWidth: 320, detailWidth: 446 });
  });

  it('keeps one pane on a Galaxy Z Fold held upright', () => {
    // 616 dp: rail 86 + list 320 left the message 211 dp.
    expect(mailTabPanes(616, 816)).toMatchObject({ isSplit: false, hasSidebar: false, listWidth: 530, detailWidth: 0 });
  });

  it('keeps the docked folder list and a wide reader on a 1280 dp tablet', () => {
    expect(mailTabPanes(1280, 800)).toMatchObject({ isSplit: true, hasSidebar: true, listWidth: 320, detailWidth: 602 });
  });

  it('keeps a phone on one pane', () => {
    expect(mailTabPanes(411, 914)).toMatchObject({ isSplit: false, hasSidebar: false, listWidth: 411, detailWidth: 0 });
  });

  it('splits a Galaxy Z Fold in landscape as before', () => {
    expect(mailTabPanes(816, 616)).toMatchObject({ isSplit: true, hasSidebar: false, listWidth: 320, detailWidth: 410 });
  });

  it('shrinks the list towards 280 dp before giving up the split', () => {
    const medium = layoutFor(700, 1000);
    expect(paneLayoutFor(medium, 650)).toMatchObject({ isSplit: true, listWidth: 290, detailWidth: READING_PANE_MIN });
    expect(paneLayoutFor(medium, 640)).toMatchObject({ isSplit: true, listWidth: 280, detailWidth: READING_PANE_MIN });
    expect(paneLayoutFor(medium, 639)).toMatchObject({ isSplit: false, listWidth: 639, detailWidth: 0 });
  });

  it('shrinks the list next to the docked folder list before undocking it', () => {
    const wide = layoutFor(1000, 800);
    expect(paneLayoutFor(wide, 914)).toMatchObject({ hasSidebar: true, listWidth: 282, detailWidth: READING_PANE_MIN });
    expect(paneLayoutFor(wide, 911)).toMatchObject({ hasSidebar: false, listWidth: 320, detailWidth: 591 });
  });

  it('never splits a window that is too short or narrow for it', () => {
    expect(paneLayoutFor(layoutFor(914, 411), 914)).toMatchObject({ isSplit: false, listWidth: 914 });
  });
});

describe('mailScreenLayoutFor', () => {
  const tablet = layoutFor(1280, 800);
  const phone = layoutFor(411, 914);

  it('waits for the stored reading pane setting on a split window (#93)', () => {
    // Before the settings are read the store holds the default, auto.
    expect(mailScreenLayoutFor(tablet, 1194, 'auto', false)).toMatchObject({ ready: false });
    expect(mailScreenLayoutFor(tablet, 1194, 'off', true)).toMatchObject({ ready: true, isSplit: false });
    expect(mailScreenLayoutFor(tablet, 1194, 'auto', true)).toMatchObject({ ready: true, isSplit: true });
  });

  it('never waits where the split does not fit', () => {
    expect(mailScreenLayoutFor(phone, 411, 'auto', false)).toMatchObject({ ready: true, isSplit: false });
    // A Fold held upright: one pane whatever the setting says.
    expect(mailScreenLayoutFor(layoutFor(616, 816), 530, 'auto', false)).toMatchObject({ ready: true, isSplit: false });
  });
});

describe('content width', () => {
  it('takes the rail and the side insets off a tab screen of a split window', () => {
    const window = layoutFor(1280, 800);
    expect(contentWidthFor(1280, window, { top: 0, left: 24, right: 24 }, true)).toBe(1280 - 48 - TAB_RAIL_WIDTH);
    // A stack screen has no rail, and a phone shows its tabs at the bottom.
    expect(contentWidthFor(1280, window, NO_INSETS, false)).toBe(1280);
    expect(contentWidthFor(411, layoutFor(411, 914), NO_INSETS, true)).toBe(411);
  });

  it('goes by the measured root once there is one', () => {
    const window = layoutFor(1280, 800);
    // Right of a 110 dp rail (a longer tab label), which keeps clear of the left inset.
    expect(measuredContentWidth(1170, true, { left: 24, right: 24 })).toBe(1146);
    // A stack screen starts at the window's edge.
    expect(measuredContentWidth(1280, false, { left: 24, right: 24 })).toBe(1232);
  });
});

describe('tab bar position', () => {
  it('keeps the rail on tablets and foldables where the split fits beside it', () => {
    expect(tabBarPositionFor(layoutFor(1280, 800), 1280, NO_INSETS)).toBe('left');
    expect(tabBarPositionFor(layoutFor(800, 1280), 800, NO_INSETS)).toBe('left');
    // iPad mini held upright: list 298 dp, reader 360 dp next to the rail.
    expect(tabBarPositionFor(layoutFor(744, 1133), 744, NO_INSETS)).toBe('left');
    // A Galaxy Z Fold held upright has one pane either way: no change.
    expect(tabBarPositionFor(layoutFor(616, 816), 616, NO_INSETS)).toBe('left');
  });

  it('keeps a phone on the bottom bar', () => {
    expect(tabBarPositionFor(layoutFor(411, 914), 411, NO_INSETS)).toBe('bottom');
    expect(tabBarPositionFor(layoutFor(914, 411), 914, NO_INSETS)).toBe('bottom');
  });

  it('keeps the bottom bar where the rail would cost the reading pane', () => {
    const edge = 640 + TAB_RAIL_WIDTH;
    expect(tabBarPositionFor(layoutFor(edge - 1, 1000), edge - 1, NO_INSETS)).toBe('bottom');
    expect(tabBarPositionFor(layoutFor(edge, 1000), edge, NO_INSETS)).toBe('left');
    expect(tabBarPositionFor(layoutFor(640, 1000), 640, NO_INSETS)).toBe('bottom');
    expect(tabBarPositionFor(layoutFor(639, 1000), 639, NO_INSETS)).toBe('left');
  });
});

describe('iPhone Duo', () => {
  // Measured on the iPhone Duo simulator (iOS 27.1): outer display 466 x 678
  // pt, inner display 669 x 951 pt.
  it('shows the list and the message side by side on the inner display held upright', () => {
    const inner = layoutFor(669, 951);
    expect(tabBarPositionFor(inner, 669, NO_INSETS)).toBe('bottom');
    expect(mailTabPanes(669, 951)).toMatchObject({ isSplit: true, hasSidebar: false, listWidth: 309, detailWidth: 360 });
  });

  it('splits the inner display turned sideways next to the rail', () => {
    expect(tabBarPositionFor(layoutFor(951, 669), 951, NO_INSETS)).toBe('left');
    expect(mailTabPanes(951, 669)).toMatchObject({ isSplit: true, hasSidebar: false, listWidth: 320, detailWidth: 545 });
  });

  it('puts the tabs in the status column where iOS keeps one on the right', () => {
    // The outer display: the status bar down the right edge, no top inset.
    const column = { top: 0, left: 0, right: 84 };
    expect(hasStatusColumn(column, 'ios')).toBe(true);
    expect(tabBarPositionFor(layoutFor(466, 678), 466, column, 'ios')).toBe('right');
    expect(tabBarPositionFor(layoutFor(951, 669), 951, column, 'ios')).toBe('right');
    // The column is the inset the screens keep clear of already: no rail to take off.
    expect(contentWidthFor(466, layoutFor(466, 678), column, true)).toBe(382);
  });

  it('keeps an iPhone in landscape, an iPad and Android off the status column', () => {
    expect(hasStatusColumn({ top: 0, left: 59, right: 59 }, 'ios')).toBe(false);
    expect(hasStatusColumn({ top: 24, left: 0, right: 0 }, 'ios')).toBe(false);
    expect(hasStatusColumn({ top: 0, left: 0, right: 48 }, 'android')).toBe(false);
    // A narrow inset is a corner or a sensor housing, too narrow for the tabs.
    expect(hasStatusColumn({ top: 0, left: 0, right: 48 }, 'ios')).toBe(false);
  });

  it('keeps one pane on the outer display', () => {
    expect(mailTabPanes(466, 678)).toMatchObject({ isSplit: false, listWidth: 466 });
    expect(mailTabPanes(678, 466)).toMatchObject({ isSplit: false, listWidth: 678 });
  });
});

describe('fitsStatusColumn', () => {
  // Back, five toolbar buttons and five bottom-bar buttons.
  const MESSAGE = 11;

  it("fits the message viewer's buttons in the column on both of the Duo's displays", () => {
    expect(fitsStatusColumn({ top: 0, left: 0, right: 84, bottom: 34 }, 678, MESSAGE, 'ios')).toBe(true);
    expect(fitsStatusColumn({ top: 0, left: 0, right: 84, bottom: 34 }, 669, MESSAGE, 'ios')).toBe(true);
  });

  it('keeps the bars where the buttons would run into the status bar', () => {
    expect(fitsStatusColumn({ top: 0, left: 0, right: 84, bottom: 34 }, 600, MESSAGE, 'ios')).toBe(false);
    expect(fitsStatusColumn({ top: 0, left: 0, right: 84, bottom: 34 }, 678, 14, 'ios')).toBe(false);
  });

  it('never puts them in a column that is not there', () => {
    expect(fitsStatusColumn({ top: 59, left: 0, right: 0, bottom: 34 }, 932, MESSAGE, 'ios')).toBe(false);
    expect(fitsStatusColumn({ top: 0, left: 0, right: 84, bottom: 34 }, 678, MESSAGE, 'android')).toBe(false);
  });
});

describe('foldAlignedPanes', () => {
  it('moves the edge between the panes to the fold of a Duo held like a book', () => {
    // Inner display sideways, the tabs in the 84 pt status column: 867 pt of room from the left edge.
    const split = { ...layoutFor(951, 669), listWidth: 320, detailWidth: 547 };
    expect(foldAlignedPanes(split, 951, 0)).toMatchObject({ isSplit: true, listWidth: 476, detailWidth: 391 });
  });

  it('keeps the panes where the fold would leave either too narrow', () => {
    const split = { ...layoutFor(951, 669), listWidth: 320, detailWidth: 300 + 360 - 320 };
    // Room 660: a list of 476 leaves the reader 184.
    expect(foldAlignedPanes(split, 951, 0)).toBe(split);
    // A list starting right of the fold.
    expect(foldAlignedPanes({ ...split, detailWidth: 900 }, 951, 300)).toMatchObject({ listWidth: 320 });
  });

  it('changes nothing on one pane', () => {
    const one = mailTabPanes(466, 678);
    expect(foldAlignedPanes(one, 466, 0)).toBe(one);
  });
});

describe('listPaneWidth', () => {
  it('stays between 320 and 420 dp', () => {
    expect(listPaneWidth(600)).toBe(320);
    expect(listPaneWidth(1000)).toBe(340);
    expect(listPaneWidth(2000)).toBe(420);
  });
});

describe('sheetSideInsets', () => {
  it('keeps a phone sheet full width inside the side insets', () => {
    expect(sheetSideInsets(411, 0, 0)).toEqual({ left: 0, right: 0 });
  });

  it('centres the sheet at 560 dp on a wide window', () => {
    expect(sheetSideInsets(1280, 0, 0)).toEqual({ left: 360, right: 360 });
    expect(sheetSideInsets(914, 0, 48)).toEqual({ left: 177, right: 177 });
  });

  it('never puts a centred sheet under a side inset', () => {
    expect(sheetSideInsets(640, 0, 48)).toEqual({ left: 48, right: 48 });
  });
});

describe('floatingCardFrame', () => {
  it('spans a phone with 12 dp margins above the tab bar', () => {
    expect(floatingCardFrame(411, false, { left: 0, right: 0 })).toEqual({ left: 12, right: 12, bottom: 64 });
  });

  it('comes down to the margin where the tabs are not along the bottom', () => {
    expect(floatingCardFrame(466, false, { left: 0, right: 84 }, 'right')).toEqual({ left: 12, right: 96, bottom: 12 });
    expect(floatingCardFrame(951, true, { left: 0, right: 84 }, 'right')).toEqual({ left: 487, right: 104, bottom: 20 });
  });

  it('spans a split layout that keeps the bottom tab bar like a phone, above the bar', () => {
    // The Duo's inner display upright: a 309 dp list has no room for a 360 dp card beside it.
    expect(floatingCardFrame(669, true, NO_INSETS, 'bottom')).toEqual({ left: 12, right: 12, bottom: 64 });
  });

  it('sits bottom right at 360 dp on a split layout', () => {
    const f = floatingCardFrame(1280, true, { left: 0, right: 0 });
    expect(1280 - f.left - f.right).toBe(360);
    expect(f.right).toBe(20);
    expect(f.bottom).toBe(20);
  });
});
