import React from 'react';
import * as WebBrowser from 'expo-web-browser';
import { useSettingsStore, type SidebarApp } from '../stores/settings-store';
import { sanitizeSidebarAppUrl } from './sidebar-app-url';

export { sanitizeSidebarAppUrl };

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
