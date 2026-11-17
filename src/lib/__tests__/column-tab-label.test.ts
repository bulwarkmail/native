import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { columnTabLabel } from '../column-tab-label';

const read = (...parts: string[]) =>
  readFileSync(join(__dirname, '..', '..', ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('a tab in the status column, as VoiceOver reads it', () => {
  it('is the name and the place', () => {
    expect(columnTabLabel('Kalender', undefined, '2 von 5')).toBe('Kalender, 2 von 5');
  });

  it('has the unread count between them', () => {
    expect(columnTabLabel('Mail', 20, '1 of 5')).toBe('Mail, 20, 1 of 5');
    expect(columnTabLabel('Mail', '99+', '1 of 5')).toBe('Mail, 99+, 1 of 5');
  });

  it('leaves an empty badge out and keeps a zero', () => {
    expect(columnTabLabel('Mail', '', '1 of 5')).toBe('Mail, 1 of 5');
    expect(columnTabLabel('Mail', null, '1 of 5')).toBe('Mail, 1 of 5');
    expect(columnTabLabel('Mail', 0, '1 of 5')).toBe('Mail, 0, 1 of 5');
  });

  it('takes its place from the app\'s language, not from English', () => {
    const bar = read('components', 'SideColumnTabBar.tsx');
    expect(bar).toMatch(/columnTabLabel\(label, badge, t\('widgets\.invites\.position'/);
    expect(bar).not.toMatch(/\} of \$\{/);
  });
});

describe('the desk inbox after a refresh that failed', () => {
  it('keeps its rows: the account\'s error is checked before the rows are replaced', () => {
    const desk = read('components', 'DeskInbox.tsx');
    const failed = desk.indexOf('if (accountId in result.errors) {');
    expect(failed).toBeGreaterThan(-1);
    expect(desk.indexOf('setRows(result.emails);')).toBeGreaterThan(failed);
    expect(desk.slice(failed, desk.indexOf('setRows(result.emails);'))).toMatch(/setFailed\(true\);\n\s+return;/);
  });
});
