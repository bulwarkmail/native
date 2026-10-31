import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { translate } from '../../../i18n';
import { canLookUpAddress, lookupMessage, lookupResult } from '../../../lib/delegation/display';
import type { Principal } from '../../../api/types';

const tEn = (key: string, fallback?: string, params?: Record<string, string | number>) => translate('en', key, fallback, params);
const sheet = fs.readFileSync(path.resolve(__dirname, '../ShareCollectionSheet.tsx'), 'utf8');

describe('sharing a calendar or address book with a typed address', () => {
  it('offers to look the address up when nobody listed has it', () => {
    // Stalwart 1.0 with directory queries off lists only the user and their groups.
    const listed: Principal[] = [{ id: 'd', type: 'individual', name: 'usera@example.org', email: 'usera@example.org' }];
    expect(canLookUpAddress('userc@example.org', listed)).toBe(true);
    expect(canLookUpAddress('usera@example.org', listed)).toBe(false);
    expect(canLookUpAddress('userc', listed)).toBe(false);
  });

  it('says why the server could not find the address instead of "No matches"', () => {
    const off = lookupResult('userc@example.org', { principal: null, status: 'forbidden' }, ['d']);
    expect(off.picked).toBeNull();
    expect(lookupMessage(off.lookup, tEn)).toMatch(/administrator has to turn on directory lookups/);
    const missing = lookupResult('nobody@example.org', { principal: null, status: 'ok' }, ['d']);
    expect(lookupMessage(missing.lookup, tEn)).toBe('Nobody on this server has the address nobody@example.org.');
    expect(lookupMessage({ state: 'idle' }, tEn)).toBeNull();
  });

  it('is wired into the share sheet: looked up on its own and shared once found', () => {
    expect(sheet).toMatch(/canLookUpAddress\(search, principals\)/);
    expect(sheet).toMatch(/await findPrincipalByEmail\(typedAddress\)/);
    expect(sheet).toMatch(/if \(shares\[picked\.id\] == null\) await applyShare\(picked\.id, addRights\);/);
    expect(sheet).toMatch(/lookupMessage\(lookup, t\)/);
  });
});
