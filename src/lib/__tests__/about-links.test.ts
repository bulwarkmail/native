import { describe, it, expect } from 'vitest';
import {
  buildIssueUrl, describePlatform, sourceCodeUrl, updateSourceUrl,
  IOS_TESTFLIGHT_URL, NATIVE_REPO_URL,
} from '../about-links';

function bodyOf(url: string): string {
  return decodeURIComponent(new URL(url).searchParams.get('body') ?? '');
}

describe('about links', () => {
  it('opens a new issue on the native repo with version and platform filled in', () => {
    const url = buildIssueUrl(
      { version: '0.1.76', commit: '6aaa479' },
      { os: 'android', osVersion: 34, release: '14', model: 'Pixel 7' },
    );
    expect(url.startsWith(`${NATIVE_REPO_URL}/issues/new?`)).toBe(true);
    const body = bodyOf(url);
    expect(body).toContain('App: v0.1.76 (6aaa479)');
    expect(body).toContain('Platform: Android 14 (API 34) · Pixel 7');
  });

  it('describes iOS by its version', () => {
    expect(describePlatform({ os: 'ios', osVersion: '18.1', model: 'iPhone' })).toBe('iOS 18.1 · iPhone');
    expect(describePlatform({ os: 'android', osVersion: 33 })).toBe('Android (API 33)');
  });

  it('links the configured source, or upstream when none or a bad one is set', () => {
    expect(sourceCodeUrl('https://git.example.org/me/bulwark')).toBe('https://git.example.org/me/bulwark');
    expect(sourceCodeUrl(undefined)).toBe(NATIVE_REPO_URL);
    expect(sourceCodeUrl('')).toBe(NATIVE_REPO_URL);
    expect(sourceCodeUrl('javascript:alert(1)')).toBe(NATIVE_REPO_URL);
  });

  it('sends iPhone users to TestFlight, not to the GitHub releases', () => {
    expect(updateSourceUrl('ios', 'https://github.com/bulwarkmail/native/releases/tag/0.1.77')).toBe(IOS_TESTFLIGHT_URL);
    expect(updateSourceUrl('android', 'https://github.com/bulwarkmail/native/releases/tag/0.1.77'))
      .toBe('https://github.com/bulwarkmail/native/releases/tag/0.1.77');
    expect(updateSourceUrl('android', null)).toBe(`${NATIVE_REPO_URL}/releases`);
  });
});
