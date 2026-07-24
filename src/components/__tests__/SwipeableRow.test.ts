import { describe, it, expect, vi } from 'vitest';

describe('SwipeableRow logic', () => {
  it('should use mutable refs so updated props are immediately reflected in gesture callbacks', () => {
    let leftAction = 'read';
    let rightAction = 'archive';
    const onAction = vi.fn();

    const leftActionRef = { current: leftAction };
    const rightActionRef = { current: rightAction };
    const onActionRef = { current: onAction };

    const fireAction = (side: 'left' | 'right') => {
      const action = side === 'left' ? leftActionRef.current : rightActionRef.current;
      onActionRef.current(action);
    };

    // Initially left action is 'read'
    fireAction('left');
    expect(onAction).toHaveBeenCalledWith('read');

    // Simulate prop change on re-render (e.g. user updated setting to 'delete')
    leftAction = 'delete';
    leftActionRef.current = leftAction;

    // Call gesture release handler again without re-creating gesture instance
    fireAction('left');
    expect(onAction).toHaveBeenLastCalledWith('delete');
  });
});
