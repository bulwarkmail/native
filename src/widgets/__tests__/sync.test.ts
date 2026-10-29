import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ BulwarkWidgets: undefined as undefined | { refreshInBackground: () => Promise<boolean> } }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: {}, NativeModules: native }));

const refreshSnapshot = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../build', () => ({ refreshSnapshot, readRegistry: vi.fn() }));
vi.mock('../render', () => ({ hasPlacedWidgets: vi.fn(async () => true), redrawAll: vi.fn(async () => undefined) }));
vi.mock('../state', () => ({ replaceAll: vi.fn() }));

const { handleAppState } = await import('../sync');

afterEach(() => {
  vi.useRealTimers();
  refreshSnapshot.mockClear();
});

describe('widget sync', () => {
  it('refreshes when the app goes to the background without waiting for a timer', async () => {
    // React Native pauses JS timers while the activity is in the background,
    // so not even a zero-delay timer may stand between leaving the app and
    // the refresh. Fake timers that never advance stand in for that.
    vi.useFakeTimers();
    handleAppState('background');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  });

  it('hands the refresh to a headless task where the app has one', async () => {
    vi.useFakeTimers();
    const refreshInBackground = vi.fn(async () => true);
    native.BulwarkWidgets = { refreshInBackground };
    handleAppState('background');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(refreshInBackground).toHaveBeenCalledTimes(1);
    expect(refreshSnapshot).not.toHaveBeenCalled();

    // Android refused to start the service: refresh in place after all.
    refreshInBackground.mockResolvedValueOnce(false);
    handleAppState('background');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    native.BulwarkWidgets = undefined;
  });

  it('leaves the app coming back to the scheduled refreshes', async () => {
    vi.useFakeTimers();
    handleAppState('active');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(refreshSnapshot).not.toHaveBeenCalled();
  });
});
