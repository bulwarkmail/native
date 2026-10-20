import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(os: string, nativeModules: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('react-native', () => ({ Platform: { OS: os }, NativeModules: nativeModules }));
  return import('../platform-capabilities');
}

afterEach(() => {
  vi.doUnmock('react-native');
});

describe('supportsSideloadUpdates', () => {
  it('is on for the GitHub build', async () => {
    const caps = await load('android', { BulwarkBuild: { distribution: 'github' } });
    expect(caps.androidDistribution).toBe('github');
    expect(caps.supportsSideloadUpdates).toBe(true);
  });

  it('is off for the Play build, which Play updates', async () => {
    const caps = await load('android', { BulwarkBuild: { distribution: 'play' } });
    expect(caps.androidDistribution).toBe('play');
    expect(caps.supportsSideloadUpdates).toBe(false);
  });

  it('treats a build without the module as the GitHub build', async () => {
    const caps = await load('android', {});
    expect(caps.supportsSideloadUpdates).toBe(true);
  });

  it('is off on iOS', async () => {
    const caps = await load('ios', {});
    expect(caps.supportsSideloadUpdates).toBe(false);
  });
});
