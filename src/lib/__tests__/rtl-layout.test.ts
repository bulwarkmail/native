import { describe, it, expect } from 'vitest';
import { bandEdgeStyle, drawerClosedX, drawerSafeEdges, toggleThumbX } from '../rtl-layout';
import { resolveRelease } from '../../components/swipe-gesture';

describe('rtl-layout', () => {
  it('pins a band to its physical edge in both directions', () => {
    expect(bandEdgeStyle('left', false)).toEqual({ left: 0, alignItems: 'flex-start', justifyContent: 'flex-start' });
    expect(bandEdgeStyle('left', true)).toEqual({ right: 0, alignItems: 'flex-end', justifyContent: 'flex-end' });
    expect(bandEdgeStyle('right', false)).toEqual({ right: 0, alignItems: 'flex-end', justifyContent: 'flex-end' });
    expect(bandEdgeStyle('right', true)).toEqual({ left: 0, alignItems: 'flex-start', justifyContent: 'flex-start' });
  });

  it('parks a closed drawer off the side it is anchored to', () => {
    expect(drawerClosedX(400, false)).toBe(-400);
    expect(drawerClosedX(400, true)).toBe(400);
  });

  it("keeps the inset on the drawer's own edge", () => {
    expect(drawerSafeEdges(false)).toEqual(['top', 'bottom', 'left']);
    expect(drawerSafeEdges(true)).toEqual(['top', 'bottom', 'right']);
  });

  it('moves the toggle thumb toward the start edge when off', () => {
    expect(toggleThumbX(false, false)).toBe(4);
    expect(toggleThumbX(true, false)).toBe(24);
    expect(toggleThumbX(false, true)).toBe(-4);
    expect(toggleThumbX(true, true)).toBe(-24);
  });

  it('leaves swipe actions physical: a rightward drag still fires rightAction in RTL', () => {
    // The gesture logic takes no direction at all, so RTL cannot remap it.
    const config = { mode: 'instant' as const, leftAction: 'delete' as const, rightAction: 'archive' as const };
    expect(resolveRelease({ dx: 200, dy: 0, vx: 0 }, config, null)).toEqual({ kind: 'fire', action: 'archive', direction: 1 });
    expect(resolveRelease({ dx: -200, dy: 0, vx: 0 }, config, null)).toEqual({ kind: 'fire', action: 'delete', direction: -1 });
  });
});
