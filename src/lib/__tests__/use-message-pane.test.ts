import { describe, it, expect } from 'vitest';

import { handedOffViewer, rowAfterRemoval } from '../use-message-pane';

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

  it('keeps to the eligible rows, first towards the end of the list', () => {
    // Rows of two accounts, a1 and b1 alternating: a1 was open at index 1.
    const rows = ['a0', 'b0', 'b1', 'a2', 'b2'];
    const inA = (row: string) => row.startsWith('a');
    expect(rowAfterRemoval(rows, { rowKey: 'a1', index: 1 }, keyOf, inA)).toBe('a2');
    // Nothing of a after it: the nearest one before.
    expect(rowAfterRemoval(['a0', 'b0', 'b1'], { rowKey: 'a1', index: 1 }, keyOf, inA)).toBe('a0');
    // None of a left: the pane closes rather than open another account's mail.
    expect(rowAfterRemoval(['b0', 'b1'], { rowKey: 'a1', index: 1 }, keyOf, inA)).toBeNull();
  });

  it('closes the pane when the message is still at its place', () => {
    // The list has not caught up yet: never reopen the message that left.
    expect(rowAfterRemoval(['a', 'b', 'c'], { rowKey: 'b', index: 1 }, keyOf)).toBeNull();
  });
});

describe('handedOffViewer', () => {
  const tabs = { key: 'tabs', name: 'MainTabs' };
  const viewer = (emailId: string) => ({ key: `viewer-${emailId}`, name: 'EmailThread', params: { emailId, threadId: 't' } });
  const handed = { emailId: 'm1', threadId: 't' };
  const notPaged = () => undefined;

  it('takes back the message the list or the pane put on the stack', () => {
    expect(handedOffViewer({ index: 1, routes: [tabs, viewer('m1')] }, handed, notPaged))
      .toEqual({ params: { emailId: 'm1', threadId: 't' }, emailId: 'm1' });
  });

  it('takes the message the viewer has paged to', () => {
    const shown = (key: string) => (key === 'viewer-m1' ? 'm2' : undefined);
    expect(handedOffViewer({ index: 1, routes: [tabs, viewer('m1')] }, handed, shown))
      .toEqual({ params: { emailId: 'm1', threadId: 't' }, emailId: 'm2' });
  });

  it('leaves a viewer the list never put there', () => {
    expect(handedOffViewer({ index: 1, routes: [tabs, viewer('m2')] }, handed, notPaged)).toBeNull();
    expect(handedOffViewer({ index: 1, routes: [tabs, viewer('m1')] }, null, notPaged)).toBeNull();
  });

  it('leaves the viewer once another screen is over it, or it is not right over the tabs', () => {
    const compose = { key: 'compose', name: 'Compose' };
    expect(handedOffViewer({ index: 2, routes: [tabs, viewer('m1'), compose] }, handed, notPaged)).toBeNull();
    expect(handedOffViewer({ index: 2, routes: [tabs, viewer('m0'), viewer('m1')] }, handed, notPaged)).toBeNull();
  });
});
