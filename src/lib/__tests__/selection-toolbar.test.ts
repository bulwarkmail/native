// Tablet portrait: the selection toolbar ran past the list column and put
// Archive and Delete over the reading pane.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fitToolbarActions } from '../selection-toolbar';

const ALL = ['star', 'read', 'tag', 'move', 'spam', 'archive', 'delete'] as const;
const opts = (width: number | null) => ({
  width,
  // EmailListScreen: 8 + 8 padding, 44 close, 24 + 4 + 4 count.
  reserved: 92,
  button: 44,
  overflowOrder: ['spam', 'tag', 'star', 'read', 'move', 'archive', 'delete'] as const,
});

describe('fitToolbarActions', () => {
  it('shows every action where they fit (a 412 dp phone)', () => {
    expect(fitToolbarActions(ALL, opts(412))).toEqual({ visible: [...ALL], overflow: [] });
  });

  it('moves the least used into "More" on a narrow list column, keeping Archive and Delete', () => {
    const fit = fitToolbarActions(ALL, opts(360));
    expect(fit.overflow).toEqual(['tag', 'spam']);
    expect(fit.visible).toEqual(['star', 'read', 'move', 'archive', 'delete']);
    // The bar, its "More" button included, fits the column.
    expect(92 + (fit.visible.length + 1) * 44).toBeLessThanOrEqual(360);
  });

  it('never needs more room than the column has', () => {
    for (let width = 150; width <= 500; width += 7) {
      const fit = fitToolbarActions(ALL, opts(width));
      const buttons = fit.visible.length + (fit.overflow.length > 0 ? 1 : 0);
      if (width >= 92 + 44) expect(92 + buttons * 44).toBeLessThanOrEqual(width);
      expect([...fit.visible, ...fit.overflow].sort()).toEqual([...ALL].sort());
    }
  });

  it('shows them all until the width is measured', () => {
    expect(fitToolbarActions(ALL, opts(null)).overflow).toEqual([]);
  });

  it('is what the list header renders', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');
    expect(src).toMatch(/onLayout=\{\(e\) => setSelectionBarWidth\(e\.nativeEvent\.layout\.width\)\}/);
    expect(src).toMatch(/toolbarFit\.visible\.map\(/);
    expect(src).toMatch(/items=\{toolbarFit\.overflow\.map\(/);
  });
});
