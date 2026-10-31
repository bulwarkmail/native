import { describe, expect, it } from 'vitest';
import { bottomQuickActionsFor, swipeActionShown, withoutArchive } from '../swipe-actions';

describe('archive action gate', () => {
  it('shows a stored Archive swipe as none while archiving is off', () => {
    expect(swipeActionShown('archive', false)).toBe('none');
    expect(swipeActionShown('archive', true)).toBe('archive');
    expect(swipeActionShown('delete', false)).toBe('delete');
  });

  it('drops Archive from the pickers while archiving is off', () => {
    const options = [{ value: 'none' }, { value: 'archive' }, { value: 'delete' }];
    expect(withoutArchive(options, false).map((o) => o.value)).toEqual(['none', 'delete']);
    expect(withoutArchive(options, true).map((o) => o.value)).toEqual(['none', 'archive', 'delete']);
  });

  it('fills a stored Archive quick action with a reply action, keeping three', () => {
    expect(bottomQuickActionsFor(['archive', 'delete', 'reply'], false)).toEqual(['delete', 'reply', 'replyAll']);
    expect(bottomQuickActionsFor(['reply', 'archive', 'replyAll'], false)).toEqual(['reply', 'replyAll', 'forward']);
    expect(bottomQuickActionsFor(['archive', 'delete', 'reply'], true)).toEqual(['archive', 'delete', 'reply']);
  });
});
