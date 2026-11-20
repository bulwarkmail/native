import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Checked on the source: the suite has no React Native renderer. Mail,
// Calendar and Contacts take their header row and menu button from
// ScreenHeader, so the menu button stays in place when the user switches
// between them (#170).
const src = path.resolve(__dirname, '../..');
const SCREENS = ['screens/EmailListScreen.tsx', 'screens/CalendarScreen.tsx', 'screens/ContactsScreen.tsx'];

function headerStyle(source: string): string {
  const start = source.indexOf('\n  header: {');
  if (start === -1) return '';
  return source.slice(start, source.indexOf('\n  },', start));
}

describe('the headers of Mail, Calendar and Contacts', () => {
  it.each(SCREENS)('%s uses the shared header row and menu button', (file) => {
    const source = fs.readFileSync(path.join(src, file), 'utf8');
    const style = headerStyle(source);

    expect(style).toContain('...screenHeaderRow');
    // Anything that moves the row's content would move the menu button too.
    expect(style).not.toMatch(/\b(padding\w*|height|minHeight|margin\w*)\s*:/);
    expect(source).toContain('<HeaderMenuButton');
    expect(source).not.toMatch(/<Menu\b/);
  });
});
