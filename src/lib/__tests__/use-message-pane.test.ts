import { describe, it, expect } from 'vitest';

import { rowAfterRemoval } from '../use-message-pane';

const keyOf = (row: string) => row;

describe('rowAfterRemoval', () => {
  it('shows the row that took the removed one\'s place', () => {
    // b was open at index 1 and has left the list.
    expect(rowAfterRemoval(['a', 'c', 'd'], { rowKey: 'b', index: 1 }, keyOf)).toBe('c');
  });

  it('falls back to the new last row when the last one went', () => {
    expect(rowAfterRemoval(['a', 'b'], { rowKey: 'c', index: 2 }, keyOf)).toBe('b');
  });

  it('closes the pane when the list is empty', () => {
    expect(rowAfterRemoval([], { rowKey: 'a', index: 0 }, keyOf)).toBeNull();
  });

  it('closes the pane when the message is still at its place', () => {
    // The list has not caught up yet: never reopen the message that left.
    expect(rowAfterRemoval(['a', 'b', 'c'], { rowKey: 'b', index: 1 }, keyOf)).toBeNull();
  });
});
