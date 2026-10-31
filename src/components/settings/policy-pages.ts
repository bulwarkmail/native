import { isFeatureEnabled, type FeatureGate, type OrgPolicy } from '../../lib/org-policy';

/**
 * Settings pages a feature gate takes away, as the webmail's settings-app.tsx
 * leaves their tabs out: Templates (templatesEnabled, in Composing there),
 * Keywords (customKeywordsEnabled: Organize turns into Folders), Sidebar apps
 * (sidebarAppsEnabled: the app has no plugins, which keep Add-ons there),
 * Themes (themesEnabled, appearance-settings.tsx), and Calendar, Contacts and
 * Files with their apps.
 */
const GATED_PAGES: ReadonlyArray<[FeatureGate, string]> = [
  ['templatesEnabled', 'templates'],
  ['customKeywordsEnabled', 'keywords'],
  ['sidebarAppsEnabled', 'sidebar_apps'],
  ['themesEnabled', 'themes'],
  ['calendarEnabled', 'calendar'],
  ['contactsEnabled', 'contacts'],
  ['filesEnabled', 'files'],
];

/**
 * Pages a hidden restriction takes away: Delegates (`delegation`, webmail
 * settings-app supportsSharing) and Recover deleted items
 * (`deletedItemsRecovery`, webmail hooks/use-deleted-items-recovery.ts).
 */
const HIDDEN_PAGES: ReadonlyArray<[string, string]> = [
  ['delegation', 'sharing'],
  ['deletedItemsRecovery', 'recovery'],
];

/** The settings pages the active account's policy leaves out, by page id. */
export function policyHiddenPages(policy: OrgPolicy | null | undefined): string[] {
  if (!policy) return [];
  const out: string[] = [];
  for (const [gate, page] of GATED_PAGES) {
    if (!isFeatureEnabled(policy, gate)) out.push(page);
  }
  for (const [key, page] of HIDDEN_PAGES) {
    if (policy.restrictions[key]?.hidden === true) out.push(page);
  }
  return out;
}
