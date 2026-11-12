import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vacationBannerShown } from '../vacation-banner';

// Webmail 1.21: the mail sidebar says out of office is on, with "Turn off".
describe('the out-of-office hint in the mail drawer', () => {
  const on = { isEnabled: true, isSupported: true, hasLoaded: true, accountId: null };

  it('shows while the own reply is on', () => {
    expect(vacationBannerShown(on)).toBe(true);
  });

  it('stays away while off, not loaded, unsupported, or for a shared account Settings loaded', () => {
    expect(vacationBannerShown({ ...on, isEnabled: false })).toBe(false);
    expect(vacationBannerShown({ ...on, hasLoaded: false })).toBe(false);
    expect(vacationBannerShown({ ...on, isSupported: false })).toBe(false);
    expect(vacationBannerShown({ ...on, accountId: 'team' })).toBe(false);
  });

  // No render setup in the repo: the drawer is checked for showing it.
  it('is at the top of the drawer, opening the out-of-office settings', () => {
    const drawer = readFileSync(join(__dirname, '../../components/SidebarDrawer.tsx'), 'utf-8');
    expect(drawer).toMatch(/<VacationDrawerBanner\r?\n\s+onOpenSettings=\{\(\) => \{ onClose\(\); setPendingSettingsTab\('vacation'\);/);
    const banner = readFileSync(join(__dirname, '../../components/VacationDrawerBanner.tsx'), 'utf-8');
    expect(banner).toMatch(/save\(\{ isEnabled: false \}\)/);
  });
});
