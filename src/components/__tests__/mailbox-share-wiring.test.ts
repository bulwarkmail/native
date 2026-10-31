import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Checked on the source: the suite has no React Native renderer.
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', file), 'utf8');

describe('folder sharing in the sidebar', () => {
  it('offers Share in the folder menu where the folder can be shared, and opens the share sheet', () => {
    const source = read('components/SidebarDrawer.tsx');
    expect(source).toMatch(/canShareMailbox\(mb, supportsMailboxSharing\(\)\)/);
    expect(source).toMatch(/key: 'share'/);
    expect(source).toMatch(/onPress: \(\) => setSharing\(\{ mailbox: mb, name \}\)/);
    // Both the docked sidebar and the drawer render the sheet.
    expect(source.match(/<MailboxShareSheet /g)).toHaveLength(2);
  });

  it('reads and writes the share through the folder sharing calls, with the folder presets', () => {
    const source = read('components/sharing/MailboxShareSheet.tsx');
    expect(source).toMatch(/getMailboxShareWith\(mailboxId, accountId\)/);
    expect(source).toMatch(/setMailboxShare\(mailboxId, principalId, rights, accountId\)/);
    expect(source).toMatch(/detectPreset\('mailbox', rights\)/);
    expect(source).not.toMatch(/freeBusy/);
  });

  it('lets the share sheet name a preset the server stored differently', () => {
    const source = read('components/sharing/ShareCollectionSheet.tsx');
    expect(source).toMatch(/detectPreset \? detectPreset\(rights\) : detectSharePreset\(rights, presets\)/);
  });
});
