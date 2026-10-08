import React from 'react';
import * as WebBrowser from 'expo-web-browser';
import { useSettingsStore, type SidebarApp } from '../stores/settings-store';

const MAX_APP_URL_LENGTH = 2048;

// Any space, C0/C1 control or Unicode separator/format character. A value
// holding one is rejected rather than trimmed, so what was validated is
// byte-for-byte what is stored and opened.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS_RE = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff]/;

/**
 * The one gate for a sidebar app URL, used on save, on listing and on open.
 * Only `https:` with a host and no embedded credentials passes; the setting
 * has never allowed `http:`, so neither does this. Returns the normalized URL,
 * or null.
 */
export function sanitizeSidebarAppUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!raw || raw.length > MAX_APP_URL_LENGTH) return null;
  if (UNSAFE_CHARS_RE.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;
  return parsed.href;
}

/**
 * Apps the user marked "show on mobile", in stored order, with any whose
 * stored URL fails the check (saved before it existed, or imported) dropped.
 */
export function selectMobileSidebarApps(apps: readonly SidebarApp[]): SidebarApp[] {
  const out: SidebarApp[] = [];
  for (const app of apps) {
    if (!app.showOnMobile) continue;
    const url = sanitizeSidebarAppUrl(app.url);
    if (url) out.push({ ...app, url });
  }
  return out;
}

export function useMobileSidebarApps(): SidebarApp[] {
  // `.filter()` in the selector would allocate a new array per call, which
  // zustand v5 reads as a changed snapshot on every render (infinite loop).
  // Subscribe to the stored array and derive from it.
  const apps = useSettingsStore((s) => s.sidebarApps);
  return React.useMemo(() => selectMobileSidebarApps(apps), [apps]);
}

/**
 * Open a sidebar app in a Custom Tab. Inline (iframe) apps have no native
 * equivalent, so both open modes use the tab. A URL that fails the check is
 * not opened.
 */
export async function openSidebarApp(app: SidebarApp): Promise<void> {
  const url = sanitizeSidebarAppUrl(app.url);
  if (!url) return;
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    // no browser available - nothing to do
  }
}
