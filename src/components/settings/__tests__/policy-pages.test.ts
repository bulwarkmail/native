import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { policyHiddenPages } from '../policy-pages';
import { sanitizePolicy } from '../../../lib/org-policy';

const screen = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'screens', 'SettingsScreen.tsx'), 'utf8');

describe('policyHiddenPages', () => {
  it('leaves every page without a policy or with the default gates', () => {
    expect(policyHiddenPages(null)).toEqual([]);
    expect(policyHiddenPages(sanitizePolicy({}))).toEqual([]);
  });

  it('takes away the pages of the gates the policy turns off', () => {
    const policy = sanitizePolicy({
      features: {
        templatesEnabled: false,
        customKeywordsEnabled: false,
        sidebarAppsEnabled: false,
        themesEnabled: false,
        calendarEnabled: false,
        contactsEnabled: false,
        filesEnabled: false,
      },
    });
    expect(policyHiddenPages(policy).sort()).toEqual(
      ['calendar', 'contacts', 'files', 'keywords', 'sidebar_apps', 'templates', 'themes'],
    );
  });

  it('takes away Delegates and Recover deleted items when the policy hides them', () => {
    const policy = sanitizePolicy({
      restrictions: { delegation: { hidden: true }, deletedItemsRecovery: { hidden: true } },
    });
    expect(policyHiddenPages(policy).sort()).toEqual(['recovery', 'sharing']);
    const locked = sanitizePolicy({ restrictions: { delegation: { locked: true } } });
    expect(policyHiddenPages(locked)).toEqual([]);
  });

  it('names pages the Settings list has', () => {
    const policy = sanitizePolicy({
      features: Object.fromEntries(['templatesEnabled', 'customKeywordsEnabled', 'sidebarAppsEnabled', 'themesEnabled', 'calendarEnabled', 'contactsEnabled', 'filesEnabled'].map((g) => [g, false])),
      restrictions: { delegation: { hidden: true }, deletedItemsRecovery: { hidden: true } },
    });
    for (const page of policyHiddenPages(policy)) expect(screen).toContain(`{ id: '${page}',`);
  });
});

describe('Settings list', () => {
  it('leaves out the pages the active policy takes away', () => {
    expect(screen).toContain('const policy = usePolicyStore((s) => s.effective);');
    expect(screen).toContain('for (const page of policyHiddenPages(policy)) set.add(page as Tab);');
    expect(screen).toContain('}, [recoveryAvailable, delegationAvailable, policy]);');
  });
});
