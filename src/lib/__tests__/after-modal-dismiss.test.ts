import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createAfterDismissQueue } from '../after-modal-dismiss';

afterEach(() => {
  vi.useRealTimers();
});

describe('createAfterDismissQueue', () => {
  it('holds the action on iOS until the modal is dismissed', () => {
    const queue = createAfterDismissQueue('ios');
    const action = vi.fn();
    queue.run(action);
    expect(action).not.toHaveBeenCalled();
    queue.flush();
    expect(action).toHaveBeenCalledTimes(1);
    queue.flush();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('runs the action after the fallback delay when onDismiss never comes', () => {
    vi.useFakeTimers();
    const queue = createAfterDismissQueue('ios', 600);
    const action = vi.fn();
    queue.run(action);
    vi.advanceTimersByTime(599);
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does not run the action twice when onDismiss and the timer both fire', () => {
    vi.useFakeTimers();
    const queue = createAfterDismissQueue('ios', 600);
    const action = vi.fn();
    queue.run(action);
    queue.flush();
    vi.advanceTimersByTime(1000);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('runs the action right away on Android', () => {
    const queue = createAfterDismissQueue('android');
    const action = vi.fn();
    queue.run(action);
    expect(action).toHaveBeenCalledTimes(1);
  });
});

// The compose "Attach" sheet closed its modal and opened the photo picker,
// camera or file picker in the same tick. On iOS the picker never showed.
describe('compose options sheet', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');

  it('opens the chosen option only after the sheet is dismissed', () => {
    expect(source).not.toMatch(/onClose\(\);\s*opt\.onPress\(\)/);
    expect(source).toMatch(/onDismiss=\{afterDismiss\.flush\}/);
    expect(source).toMatch(/afterDismiss\.run\(opt\.onPress\)/);
  });
});
