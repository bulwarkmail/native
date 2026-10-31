import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { translate } from '../../../i18n';
import { principalRowDisplay, resolvePrincipal } from '../display';

const tEn = (key: string, fallback?: string, params?: Record<string, string | number>) => translate('en', key, fallback, params);

describe('someone with access the server does not name', () => {
  // Stalwart 1.0 with directory queries off: Principal/get answers notFound
  // for the sharee's id ("e") and the session does not list them.
  it('reads as "Unknown person" without the id as an address', () => {
    const principal = resolvePrincipal('e', { directory: [], remembered: new Map(), sessionAccounts: new Map() });
    expect(principal).toBeNull();
    expect(principalRowDisplay(principal, tEn)).toEqual({ name: 'Unknown person', detail: null });
  });

  it('reads as the person when the directory names them (0.16)', () => {
    const userB = { id: 'e', type: 'individual' as const, name: 'userb@example.org', email: 'userb@example.org', description: 'User B' };
    const principal = resolvePrincipal('e', { directory: [userB], remembered: new Map(), sessionAccounts: new Map() });
    expect(principalRowDisplay(principal, tEn)).toEqual({ name: 'userb@example.org', detail: 'User B' });
  });

  it('is the row the Delegates settings list shows', () => {
    // On Stalwart 1.0.1 the row read "Unknown person" over "e".
    const settings = fs.readFileSync(path.resolve(__dirname, '../../../components/settings/DelegateSettings.tsx'), 'utf8');
    expect(settings).toMatch(/const display = principalRowDisplay\(principal, t\);/);
    expect(settings).not.toMatch(/detail: summary\.principalId/);
  });

  it('gets no id for an address line in the calendar and address book share sheet', () => {
    const sheet = fs.readFileSync(path.resolve(__dirname, '../../../components/sharing/ShareCollectionSheet.tsx'), 'utf8');
    const label = sheet.slice(sheet.indexOf('const renderPrincipalLabel'), sheet.indexOf('return (', sheet.indexOf('const renderPrincipalLabel')) + 900);
    expect(label).not.toMatch(/p\?\.email \|\| principalId/);
    expect(label).toMatch(/\{p\?\.email \? \(/);
  });
});
