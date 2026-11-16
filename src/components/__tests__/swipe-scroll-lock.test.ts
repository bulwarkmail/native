import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createScrollLock } from '../swipe-scroll-lock';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('createScrollLock', () => {
  it('stops the list scrolling while a row is swiped and lets it scroll again on release', () => {
    const onChange = vi.fn();
    const lock = createScrollLock(onChange);
    const release = lock.hold();
    expect(onChange).toHaveBeenLastCalledWith(true);
    release();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps the list still until every swiping row lets go', () => {
    const onChange = vi.fn();
    const lock = createScrollLock(onChange);
    const a = lock.hold();
    const b = lock.hold();
    a();
    expect(onChange).toHaveBeenLastCalledWith(true);
    b();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('cannot leave the list frozen when a row lets go twice', () => {
    const onChange = vi.fn();
    const lock = createScrollLock(onChange);
    const a = lock.hold();
    a();
    a();
    const b = lock.hold();
    expect(onChange).toHaveBeenLastCalledWith(true);
    b();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});

describe('swipe scroll lock wiring', () => {
  it('holds the lock from the moment a swipe starts until it ends or the row goes away', () => {
    const row = read('components/SwipeableRow.tsx');
    expect(row).toMatch(/useContext\(SwipeScrollLockContext\)/);
    expect(row).toMatch(/\.onStart\(\(\) => \{[^}]*runOnJS\(begin\)\(\)/);
    expect(row).toMatch(/\.onFinalize\(\(\) => \{[^}]*runOnJS\(releaseScroll\)\(\)/);
    expect(row).toMatch(/useEffect\(\(\) => releaseScroll, \[\]\)/);
  });

  it('locks the list without re-rendering it', () => {
    const list = read('components/SwipeLockedFlatList.tsx');
    expect(list).toMatch(/setNativeProps\(\{ scrollEnabled/);
    expect(list).not.toMatch(/useState/);
  });

  it('applies to the folder list and the unified views', () => {
    for (const screen of ['screens/EmailListScreen.tsx', 'screens/UnifiedInboxScreen.tsx']) {
      const src = read(screen);
      expect(src).toMatch(/<SwipeLockedFlatList\s+ref=\{listRef\}/);
    }
  });
});
