import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Mocked = {
  setSecure: ReturnType<typeof vi.fn>;
  setRecentsHidden: ReturnType<typeof vi.fn>;
  setSystemBarsAppearance: ReturnType<typeof vi.fn>;
  getConstants: ReturnType<typeof vi.fn>;
};

function mockNative(os: string, module: Mocked | undefined) {
  vi.doMock('react-native', () => ({
    Platform: { OS: os },
    NativeModules: module ? { BulwarkWindow: module } : {},
  }));
}

function makeModule(supportsRecentsHiding = true): Mocked {
  return {
    setSecure: vi.fn(),
    setRecentsHidden: vi.fn(),
    setSystemBarsAppearance: vi.fn(),
    getConstants: vi.fn(() => ({ supportsRecentsHiding })),
  };
}

describe('screen-privacy', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('react-native');
  });

  it('forwards the screenshot block to the native module', async () => {
    const mod = makeModule();
    mockNative('android', mod);
    const { setScreenshotsBlocked } = await import('../screen-privacy');
    setScreenshotsBlocked(true);
    setScreenshotsBlocked(false);
    expect(mod.setSecure.mock.calls).toEqual([[true], [false]]);
  });

  it('forwards the recents hiding to the native module', async () => {
    const mod = makeModule();
    mockNative('android', mod);
    const { setHiddenInRecents } = await import('../screen-privacy');
    setHiddenInRecents(true);
    expect(mod.setRecentsHidden).toHaveBeenCalledWith(true);
  });

  it('forwards the system bar appearance to the native module', async () => {
    const mod = makeModule();
    mockNative('android', mod);
    const { setSystemBarsLight } = await import('../screen-privacy');
    setSystemBarsLight(true);
    setSystemBarsLight(false);
    expect(mod.setSystemBarsAppearance.mock.calls).toEqual([[true], [false]]);
  });

  it('reports recents hiding as the module reports it (API 33+)', async () => {
    mockNative('android', makeModule(false));
    const old = await import('../screen-privacy');
    expect(old.supportsRecentsHiding()).toBe(false);

    vi.resetModules();
    mockNative('android', makeModule(true));
    const current = await import('../screen-privacy');
    expect(current.supportsRecentsHiding()).toBe(true);
  });

  it('does nothing off Android', async () => {
    const mod = makeModule();
    mockNative('ios', mod);
    const sp = await import('../screen-privacy');
    sp.setScreenshotsBlocked(true);
    sp.setHiddenInRecents(true);
    sp.setSystemBarsLight(true);
    expect(sp.supportsScreenPrivacy()).toBe(false);
    expect(sp.supportsRecentsHiding()).toBe(false);
    expect(mod.setSecure).not.toHaveBeenCalled();
    expect(mod.setRecentsHidden).not.toHaveBeenCalled();
    expect(mod.setSystemBarsAppearance).not.toHaveBeenCalled();
  });

  it('does not throw when the native module is missing', async () => {
    mockNative('android', undefined);
    const sp = await import('../screen-privacy');
    expect(() => {
      sp.setScreenshotsBlocked(true);
      sp.setHiddenInRecents(true);
      sp.setSystemBarsLight(false);
    }).not.toThrow();
    expect(sp.supportsScreenPrivacy()).toBe(false);
    expect(sp.supportsRecentsHiding()).toBe(false);
  });
});
