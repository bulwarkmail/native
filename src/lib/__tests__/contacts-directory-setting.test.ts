import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useSettingsStore, isPolicySettingKey } from '../../stores/settings-store';
import { settingKeyFor, rulesFor } from '../../stores/policy-store';
import { sanitizePolicy } from '../org-policy';

// Webmail #1457: users and admins can turn the Directory entry in Contacts off.
describe('the contacts directory setting', () => {
  it('is on by default', () => {
    expect(useSettingsStore.getState().showContactsDirectory).toBe(true);
  });

  it('is the webmail key, so the admin policy can preset and lock it', () => {
    expect(isPolicySettingKey('showContactsDirectory')).toBe(true);
    expect(settingKeyFor('showContactsDirectory')).toBe('showContactsDirectory');
    const policy = sanitizePolicy({ restrictions: { showContactsDirectory: { locked: true, value: false } } });
    const rules = rulesFor(policy);
    expect(rules.locks.showContactsDirectory).toBe(false);
  });

  // No render setup in the repo: the screens are checked for the setting.
  it('hides the Directory entry in Contacts and is a switch in the settings', () => {
    const screen = readFileSync(join(__dirname, '../../screens/ContactsScreen.tsx'), 'utf-8');
    expect(screen).toMatch(/const directoryAvailable = supportsSharing\(\) && showContactsDirectory;/);
    expect(screen).toMatch(/showDirectory && directoryAvailable && !selectionMode \? <DirectoryBrowser/);
    const settings = readFileSync(join(__dirname, '../../components/settings/ContactsSettings.tsx'), 'utf-8');
    expect(settings).toMatch(/updateSetting\('showContactsDirectory', checked\)/);
    expect(settings).toMatch(/locked=\{directoryLocked\}/);
  });
});
