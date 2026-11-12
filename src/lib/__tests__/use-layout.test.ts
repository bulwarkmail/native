import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({ useWindowDimensions: () => ({ width: 411, height: 914 }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import {
  DETAIL_PANE_MIN, TAB_RAIL_WIDTH, contentWidthFor, floatingCardFrame, layoutFor, listPaneWidth, mailLayoutFor,
  mailScreenLayoutFor, measuredContentWidth, paneLayoutFor, sheetSideInsets,
} from '../use-layout';

const NO_INSETS = { left: 0, right: 0 };

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
  it('leaves the window\'s layout alone on auto', () => {
    const tablet = layoutFor(1280, 800);
    expect(mailLayoutFor(tablet, 'auto', 1194)).toMatchObject(tablet);
  });

  it('keeps the single pane and the folder drawer with the reading pane off (#93)', () => {
    // A wide window: the split and the docked sidebar.
    const tablet = layoutFor(1280, 800);
    expect(tablet.isSplit).toBe(true);
    expect(tablet.hasSidebar).toBe(true);
    expect(mailLayoutFor(tablet, 'off', 1194)).toEqual({
      ...tablet, isSplit: false, hasSidebar: false, listWidth: 1194, detailWidth: 0,
    });
  });

  it('changes nothing on a phone', () => {
    const phone = layoutFor(411, 914);
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
    expect(paneLayoutFor(medium, 650)).toMatchObject({ isSplit: true, listWidth: 290, detailWidth: DETAIL_PANE_MIN });
    expect(paneLayoutFor(medium, 640)).toMatchObject({ isSplit: true, listWidth: 280, detailWidth: DETAIL_PANE_MIN });
    expect(paneLayoutFor(medium, 639)).toMatchObject({ isSplit: false, listWidth: 639, detailWidth: 0 });
  });

  it('shrinks the list next to the docked folder list before undocking it', () => {
    const wide = layoutFor(1000, 800);
    expect(paneLayoutFor(wide, 914)).toMatchObject({ hasSidebar: true, listWidth: 282, detailWidth: DETAIL_PANE_MIN });
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
    expect(mailScreenLayoutFor(tablet, 1194, 'off', true)).toMatchObject({ ready: true, isSplit: false, windowIsSplit: true });
    expect(mailScreenLayoutFor(tablet, 1194, 'auto', true)).toMatchObject({ ready: true, isSplit: true, windowIsSplit: true });
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
    expect(contentWidthFor(1280, window, { left: 24, right: 24 }, true)).toBe(1280 - 48 - TAB_RAIL_WIDTH);
    // A stack screen has no rail, and a phone shows its tabs at the bottom.
    expect(contentWidthFor(1280, window, NO_INSETS, false)).toBe(1280);
    expect(contentWidthFor(411, layoutFor(411, 914), NO_INSETS, true)).toBe(411);
  });

  it('goes by the measured root once there is one', () => {
    const window = layoutFor(1280, 800);
    // Right of a 110 dp rail (a longer tab label), which keeps clear of the left inset.
    expect(measuredContentWidth(1170, window, { left: 24, right: 24 }, true)).toBe(1146);
    // A stack screen starts at the window's edge.
    expect(measuredContentWidth(1280, window, { left: 24, right: 24 }, false)).toBe(1232);
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

  it('sits bottom right at 360 dp on a split layout', () => {
    const f = floatingCardFrame(1280, true, { left: 0, right: 0 });
    expect(1280 - f.left - f.right).toBe(360);
    expect(f.right).toBe(20);
    expect(f.bottom).toBe(20);
  });
});
