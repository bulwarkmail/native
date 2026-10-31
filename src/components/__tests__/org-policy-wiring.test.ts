import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Where the organisation policy reaches the UI. No React Native renderer in
// the test env, so this checks the wiring; what the policy does to the
// settings is tested in org-policy.test.ts, policy-store.test.ts and
// settings-store-policy.test.ts.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', '..', rel), 'utf8');

describe('organisation policy in the UI', () => {
  it('starts following the policy at launch', () => {
    expect(read('App.tsx')).toMatch(/const stopPolicySync = startPolicySync\(\);/);
  });

  it('hides the Calendar, Contacts and Files tabs a policy turns off', () => {
    const app = read('App.tsx');
    for (const [gate, name] of [['calendarEnabled', 'calendar'], ['contactsEnabled', 'contacts'], ['filesEnabled', 'files']]) {
      expect(app).toContain(`const ${name}Allowed = usePolicyFeature('${gate}');`);
      expect(app).toContain(`...(${name}Allowed ? null : hiddenTab),`);
    }
  });

  it('shows a locked setting as set by the organisation and keeps its control still', () => {
    const item = read('src/components/settings/settings-section.tsx');
    expect(item).toContain("{locked && <Text style={styles.settingDescription}>{t('settings.org_locked', 'Set by your organisation')}</Text>}");
    expect(item).toContain("pointerEvents={locked ? 'none' : 'auto'}");
  });

  it('marks the settings of gated features as locked', () => {
    const layout = read('src/components/settings/LayoutSettings.tsx');
    for (const key of ['unifiedCrossAccount', 'enableCrossUnreadView', 'enableCrossStarredView', 'enableCrossAllView']) {
      expect(layout).toContain(`useSettingLocked('${key}')`);
    }
    expect(read('src/components/settings/TroubleshootingSettings.tsx')).toMatch(/locked=\{debugModeLocked\}/);
  });

  it("lists the operator's help links on About", () => {
    const about = read('src/components/settings/AboutSettings.tsx');
    expect(about).toContain('const operatorLinks = usePolicyStore((s) => s.links);');
    expect(about).toContain('{helpLinks(operatorLinks).map((link) => (');
  });
});
