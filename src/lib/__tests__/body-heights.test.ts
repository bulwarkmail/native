import { describe, it, expect, beforeEach } from 'vitest';
import { clearBodyHeights, estimateBodyHeight, lastBodyHeight, rememberBodyHeight } from '../body-heights';

beforeEach(() => {
  clearBodyHeights();
});

describe('body heights', () => {
  it('gives back the height a body had at the same width', () => {
    rememberBodyHeight('|e1', 411.4, 1830);
    expect(lastBodyHeight('|e1', 411.4)).toBe(1830);
    expect(lastBodyHeight('|e1', 411)).toBe(1830);
    // Rotated: the old height says nothing.
    expect(lastBodyHeight('|e1', 891)).toBeUndefined();
    expect(lastBodyHeight('group|e1', 411)).toBeUndefined();
  });

  it('ignores reports that are not a height', () => {
    rememberBodyHeight('|e1', 400, 0);
    rememberBodyHeight('|e1', 400, Number.NaN);
    expect(lastBodyHeight('|e1', 400)).toBeUndefined();
  });

  it('forgets the oldest heights first', () => {
    for (let i = 0; i <= 200; i++) rememberBodyHeight(`|m${i}`, 400, 100 + i);
    expect(lastBodyHeight('|m0', 400)).toBeUndefined();
    expect(lastBodyHeight('|m200', 400)).toBe(300);
  });
});

describe('estimateBodyHeight', () => {
  it('gives an HTML body most of a screen', () => {
    expect(estimateBodyHeight({ isHtml: true, width: 400, windowHeight: 800 })).toBe(480);
  });

  it('counts wrapped lines of plain text', () => {
    const short = estimateBodyHeight({ isHtml: false, text: 'Thanks!', width: 400, windowHeight: 800 });
    const long = estimateBodyHeight({ isHtml: false, text: 'word '.repeat(400), width: 400, windowHeight: 800 });
    const lines = estimateBodyHeight({ isHtml: false, text: 'a\n'.repeat(30), width: 400, windowHeight: 800 });
    expect(short).toBe(120);
    expect(long).toBeGreaterThan(short);
    // 31 lines of 22.4 px plus padding.
    expect(lines).toBe(Math.round(31 * 22.4 + 40));
  });

  it('stays within bounds', () => {
    expect(estimateBodyHeight({ isHtml: false, text: 'x\n'.repeat(10_000), width: 400, windowHeight: 800 })).toBe(4000);
    expect(estimateBodyHeight({ isHtml: true, width: 400, windowHeight: 100 })).toBe(120);
  });
});
