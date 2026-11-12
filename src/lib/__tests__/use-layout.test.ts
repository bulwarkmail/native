import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({ useWindowDimensions: () => ({ width: 411, height: 914 }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import {
  DOCKED_WIDTH, READING_PANE_MIN, floatingCardFrame, layoutFor, listPaneWidth, mailLayoutFor, sheetSideInsets,
} from '../use-layout';

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
    expect(mail(1280, 800)).toEqual(tablet);
  });

  it('keeps the split without a sidebar on a tablet in portrait', () => {
    expect(mail(800, 1280)).toEqual(layoutFor(800, 1280));
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
    expect(mailLayoutFor(wide, 'auto', 680).isSplit).toBe(true); // 320 + 360
    expect(mailLayoutFor(wide, 'auto', 679).isSplit).toBe(false);
    expect(mailLayoutFor(wide, 'auto', 680 + DOCKED_WIDTH).hasSidebar).toBe(true);
    expect(mailLayoutFor(wide, 'auto', 679 + DOCKED_WIDTH).hasSidebar).toBe(false);
  });

  it('never docks the sidebar on a medium window, whatever the room', () => {
    expect(mailLayoutFor(layoutFor(839, 900), 'auto', 2000).hasSidebar).toBe(false);
  });

  it('keeps the single pane and the folder drawer with the reading pane off (#93)', () => {
    // A wide portrait window, as on an open foldable: the split and the docked sidebar.
    const fold = layoutFor(1280, 1104);
    expect(fold.isSplit).toBe(true);
    expect(fold.hasSidebar).toBe(true);
    expect(mailLayoutFor(fold, 'off', 1280 - RAIL)).toEqual({ ...fold, isSplit: false, hasSidebar: false });
  });

  it('changes nothing on a phone', () => {
    const phone = layoutFor(411, 914);
    expect(mailLayoutFor(phone, 'auto', 411)).toEqual(phone);
    expect(mailLayoutFor(phone, 'off', 411)).toEqual(phone);
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
