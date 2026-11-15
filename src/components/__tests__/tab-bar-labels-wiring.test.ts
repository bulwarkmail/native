import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #128: Appearance > Show Toolbar Labels also shows or hides the names under
// the tab icons (Mail, Calendar, Contacts, Files, Settings). No React Native
// renderer in the test env, so this checks the wiring in App.tsx.

const app = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'App.tsx'), 'utf8').replace(/\r\n/g, '\n');

describe('tab bar labels', () => {
  it('follow the Show Toolbar Labels setting', () => {
    expect(app).toContain('const showTabLabels = useSettingsStore((state) => state.showToolbarLabels);');
    expect(app).toContain('tabBarShowLabel: showTabLabels,');
  });

  // The navigator leaves an icon at the top of the room its name had.
  it('centre the icons when the names are off, on dimmed tabs too', () => {
    expect(app).toContain("const tabItemStyle = showTabLabels ? undefined : ({ justifyContent: 'center' } as const);");
    expect(app).toContain('tabBarItemStyle: tabItemStyle,');
    for (const has of ['hasCalendar', 'hasContacts', 'hasFiles']) {
      expect(app).toContain(`tabBarItemStyle: ${has} ? tabItemStyle : [tabItemStyle, disabledTabStyle],`);
    }
  });

  // TalkBack reads a tab's own text, and an icon-only tab has none. Calendar,
  // Contacts and Files always carry a name (it says when they are unavailable).
  it('leave every icon-only tab a name for TalkBack', () => {
    expect(app).toContain("(Platform.OS === 'android' && !showTabLabels ? { tabBarAccessibilityLabel: name } : null);");
    expect(app).toMatch(/\.\.\.iconOnlyTabName\(inboxUnreadCount > 0 \? `[^`]*, \$\{tabLabels\.mail\}` : tabLabels\.mail\),/);
    expect(app).toContain('...iconOnlyTabName(tabLabels.settings),');
    for (const tab of ['calendar', 'contacts', 'files']) {
      expect(app).toMatch(new RegExp(`tabBarAccessibilityLabel: has\\w+ \\? tabLabels\\.${tab} : unavailable\\(tabLabels\\.${tab}\\),`));
    }
  });
});
