import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setPendingSenderSearch, usePendingMailSearch } from '../pending-mail-search';

// The address sheet had no "Find mail" from that person (webmail
// address-context-menu.tsx, acb827bf1).

describe('Find mail from an address', () => {
  it('parks the sender for the mail list, once', () => {
    setPendingSenderSearch('bob@example.org');
    expect(usePendingMailSearch.getState().from).toBe('bob@example.org');
    expect(usePendingMailSearch.getState().consumeFrom()).toBe('bob@example.org');
    expect(usePendingMailSearch.getState().consumeFrom()).toBeNull();
    // A text search stays its own.
    expect(usePendingMailSearch.getState().query).toBeNull();
  });

  it('is offered in the address sheet and applied as the From filter by the list', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
    const sheet = read('components/email/AddressActionSheet.tsx');
    expect(sheet).toMatch(/context_menu\.find_emails_from/);
    expect(sheet).toMatch(/setPendingSenderSearch\(email\);\r?\n\s*navigation\.navigate\('MainTabs', \{ screen: 'Mail' \}/);
    const list = read('screens/EmailListScreen.tsx');
    expect(list).toMatch(/const from = usePendingMailSearch\.getState\(\)\.consumeFrom\(\);/);
    expect(list).toMatch(/setFilters\(\{ \.\.\.useEmailStore\.getState\(\)\.filters, from \}\);/);
  });
});
