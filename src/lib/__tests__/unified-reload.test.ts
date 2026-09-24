import { describe, it, expect } from 'vitest';
import {
  createUnifiedReloadTracker,
  DETACHED_RELOAD_AFTER_MS,
  LATE_ECHO_WINDOW_MS,
} from '../unified-reload';

function setup() {
  let t = 1_000_000;
  const tracker = createUnifiedReloadTracker(() => t);
  return { tracker, advance: (ms: number) => { t += ms; } };
}

const accounts = ['a@x'];
const opts = { role: 'inbox' };

describe('unified inbox reload on focus', () => {
  it('loads on the first focus', () => {
    const { tracker } = setup();
    expect(tracker.focus([accounts, opts], 'a@x')).toBe(true);
  });

  it('does not reload when coming back and nothing changed', () => {
    const { tracker, advance } = setup();
    tracker.focus([accounts, opts], 'a@x');
    tracker.loaded([accounts, opts], 'a@x', false);
    tracker.blur();
    advance(10 * 60_000);
    expect(tracker.focus([accounts, opts], 'a@x')).toBe(false);
  });

  it('reloads after an Email state change seen while away', () => {
    const { tracker } = setup();
    tracker.loaded([accounts, opts], 'a@x', false);
    tracker.blur();
    expect(tracker.changeArrived()).toBe(false);
    expect(tracker.focus([accounts, opts], 'a@x')).toBe(true);
  });

  it('reloads after opening an unread message', () => {
    const { tracker } = setup();
    tracker.focus([accounts, opts], 'a@x');
    tracker.loaded([accounts, opts], 'a@x', false);
    tracker.markStale();
    tracker.blur();
    expect(tracker.focus([accounts, opts], 'a@x')).toBe(true);
  });

  it('reloads when the inputs or the active account changed', () => {
    const { tracker } = setup();
    tracker.loaded([accounts, opts], 'a@x', false);
    expect(tracker.focus([accounts, { role: 'sent' }], 'a@x')).toBe(true);
    tracker.loaded([accounts, opts], 'a@x', false);
    expect(tracker.focus([accounts, opts], 'b@x')).toBe(true);
  });

  it('reloads accounts without a live session once the last load is a minute old', () => {
    const { tracker, advance } = setup();
    tracker.loaded([accounts, opts], 'a@x', true);
    advance(DETACHED_RELOAD_AFTER_MS - 1);
    expect(tracker.focus([accounts, opts], 'a@x')).toBe(false);
    tracker.blur();
    advance(1);
    expect(tracker.focus([accounts, opts], 'a@x')).toBe(true);
  });

  it('reloads for a late echo right after a skipped reload, not later', () => {
    const { tracker, advance } = setup();
    tracker.loaded([accounts, opts], 'a@x', false);
    expect(tracker.focus([accounts, opts], 'a@x')).toBe(false);
    advance(LATE_ECHO_WINDOW_MS - 1);
    expect(tracker.changeArrived()).toBe(true);
    tracker.loaded([accounts, opts], 'a@x', false);
    advance(2);
    // Our own swipe's echo much later only marks the view stale.
    expect(tracker.changeArrived()).toBe(false);
  });

  it('keeps a change that arrives during a load for the next focus', () => {
    const { tracker } = setup();
    tracker.loaded([accounts, opts], 'a@x', false);
    tracker.changeArrived();
    tracker.blur();
    expect(tracker.focus([accounts, opts], 'a@x')).toBe(true);
  });
});
