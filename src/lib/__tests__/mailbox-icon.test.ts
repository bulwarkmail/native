import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { mailboxIconKind } from '../mailbox-icon';

describe('mailboxIconKind', () => {
  it('gives each special-use role its icon', () => {
    expect(mailboxIconKind('sent', false, false)).toBe('sent');
    expect(mailboxIconKind('junk', false, false)).toBe('junk');
    expect(mailboxIconKind('spam', false, false)).toBe('junk');
    expect(mailboxIconKind('trash', true, true)).toBe('trash');
  });

  // native #80: a sieve-sorted folder "web/sentry" got the Sent icon.
  it('gives a user folder a folder icon whatever its name says', () => {
    for (const name of ['sentry', 'Sent Items', 'Drafts old', 'memory', 'spam-reports', 'archive 2019']) {
      expect(mailboxIconKind(null, false, false), name).toBe('folder');
    }
    expect(mailboxIconKind(undefined, true, true)).toBe('folder-open');
    expect(mailboxIconKind(null, true, false)).toBe('folder');
  });

  it('is what the sidebar uses, with no guess from the folder name', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/components/SidebarDrawer.tsx'), 'utf8');
    expect(source).toContain('mailboxIconKind(');
    expect(source).not.toMatch(/lower\.includes\('(?:sent|inbox|draft|trash|junk|archive|star)'\)/);
  });
});
