import { describe, expect, it } from 'vitest';
import { buildRowActions, parseRowAction } from '../list-row-actions';
import { buildRowLabel } from '../list-row-label';
import { DARK_COLORS, LIGHT_COLORS } from '../../theme/tokens';

const base = {
  swipeLabel: (a: string) => `do ${a}`,
  attachmentNames: [] as string[],
  openAttachmentLabel: (n: string) => `Open attachment: ${n}`,
  selectLabel: 'Select',
};

describe('buildRowActions', () => {
  it('offers both swipe actions, the code, each chip and select', () => {
    const actions = buildRowActions({
      ...base, swipeLeft: 'archive', swipeRight: 'read', copyCodeLabel: 'Copy code 123456',
      attachmentNames: ['a.pdf', 'b.png'],
    });
    expect(actions).toEqual([
      { name: 'swipe:archive', label: 'do archive' },
      { name: 'swipe:read', label: 'do read' },
      { name: 'code', label: 'Copy code 123456' },
      { name: 'attachment:0', label: 'Open attachment: a.pdf' },
      { name: 'attachment:1', label: 'Open attachment: b.png' },
      { name: 'select', label: 'Select' },
    ]);
  });
  it('skips none and duplicates, and the code when absent', () => {
    expect(buildRowActions({ ...base, swipeLeft: 'none', swipeRight: 'none' }).map((a) => a.name)).toEqual(['select']);
    expect(buildRowActions({ ...base, swipeLeft: 'star', swipeRight: 'star' }).map((a) => a.name)).toEqual(['swipe:star', 'select']);
  });
  it('parses its own names back', () => {
    expect(parseRowAction('swipe:delete')).toEqual({ kind: 'swipe', action: 'delete' });
    expect(parseRowAction('attachment:1')).toEqual({ kind: 'attachment', index: 1 });
    expect(parseRowAction('code')).toEqual({ kind: 'code' });
    expect(parseRowAction('select')).toEqual({ kind: 'select' });
    expect(parseRowAction('attachment:x')).toBeNull();
    expect(parseRowAction('bogus')).toBeNull();
  });
});

describe('buildRowLabel details', () => {
  it('includes pinned, replied, forwarded, thread count and tags', () => {
    expect(buildRowLabel({
      sender: 'Ann', subject: 'Hi', time: '9:00', unread: 'unread', pinned: 'Pinned', replied: 'Replied',
      forwarded: 'Forwarded', threadCount: '3 messages', tags: ['Work', 'Red'],
    })).toBe('unread, Ann, Hi, 9:00, 3 messages, Pinned, Replied, Forwarded, Work, Red');
  });
});

describe('theme tag palettes', () => {
  it('light and dark define the same tag keys', () => {
    expect(Object.keys(LIGHT_COLORS.tags).sort()).toEqual(Object.keys(DARK_COLORS.tags).sort());
  });
});
