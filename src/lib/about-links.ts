// Links on Settings → About: where the source is, where iPhone users get the
// app, and a prefilled GitHub issue. Kept free of React Native so it can be
// unit-tested; the screen passes in the platform details.

export const NATIVE_REPO_URL = 'https://github.com/bulwarkmail/native';

/** Public TestFlight link (README). There is no App Store listing yet. */
export const IOS_TESTFLIGHT_URL = 'https://testflight.apple.com/join/rumcjNSp';

export interface DeviceInfo {
  os: string;
  /** Platform.Version: the API level on Android, the OS version on iOS. */
  osVersion: string | number;
  /** Android's release name ("14"), when known. */
  release?: string;
  model?: string;
}

/**
 * Where "Source code" points. A build can set `extra.sourceCodeUrl` in
 * app.config.js (SOURCE_CODE_URL at build time), like the webmail's
 * sourceCodeUrl: someone who ships a modified app links their own source
 * (AGPL §13). Anything that isn't an http(s) URL falls back to upstream.
 */
export function sourceCodeUrl(configured: unknown): string {
  if (typeof configured === 'string' && /^https?:\/\/\S+$/i.test(configured.trim())) return configured.trim();
  return NATIVE_REPO_URL;
}

/** "Android 14 (API 34) · Pixel 7", "iOS 18.1 · iPhone". */
export function describePlatform(d: DeviceInfo): string {
  let os: string;
  if (d.os === 'android') {
    os = d.release ? `Android ${d.release} (API ${d.osVersion})` : `Android (API ${d.osVersion})`;
  } else if (d.os === 'ios') {
    os = `iOS ${d.osVersion}`;
  } else {
    os = `${d.os} ${d.osVersion}`;
  }
  return d.model ? `${os} · ${d.model}` : os;
}

/** A new-issue link on the native repo with the version and platform filled in. */
export function buildIssueUrl(app: { version: string; commit: string }, device: DeviceInfo): string {
  const body = [
    '**What happened?**',
    '',
    '',
    '**What did you expect?**',
    '',
    '',
    '**Steps to reproduce**',
    '1. ',
    '',
    '---',
    `App: v${app.version} (${app.commit})`,
    `Platform: ${describePlatform(device)}`,
  ].join('\n');
  return `${NATIVE_REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}

/**
 * Where an update comes from on this platform: Android installs it in-app
 * (Settings → Updates), iOS gets it from TestFlight.
 */
export function updateSourceUrl(os: string, releaseUrl: string | null | undefined): string {
  if (os === 'ios') return IOS_TESTFLIGHT_URL;
  return releaseUrl || `${NATIVE_REPO_URL}/releases`;
}
