import { describe, expect, it } from 'vitest';
import { translate } from '../../../i18n';
import {
  canLookUpAddress,
  delegateCandidates,
  describeSummary,
  lookupResult,
  principalDisplay,
  resolvePrincipal,
} from '../display';
import { summarizeDelegates } from '../delegation';
import type { ShareTarget } from '../share-batch';
import { CALENDAR_PRESETS, FILE_PRESETS, MAILBOX_PRESETS } from '../share-rights';
import type { Principal } from '../../../api/types';

const tEn = (key: string, fallback?: string, params?: Record<string, string | number>) => translate('en', key, fallback, params);

const bob: Principal = { id: 'cj', type: 'individual', name: 'Bob', email: 'bob@example.org' };
const team: Principal = { id: 'cg', type: 'group', name: 'team@example.org', email: 'team@example.org' };

describe('principalDisplay', () => {
  it('names a person and shows their address under the name', () => {
    expect(principalDisplay(bob)).toEqual({ name: 'Bob', detail: 'bob@example.org' });
    expect(principalDisplay(team)).toEqual({ name: 'team@example.org', detail: null });
    expect(principalDisplay({ id: 'x', name: '', email: null, description: 'Room 1' })).toEqual({ name: 'x', detail: 'Room 1' });
  });
});

describe('resolvePrincipal', () => {
  it('asks the directory, then the names kept on the device, then the shared accounts in the session', () => {
    const remembered = new Map([['ck', { id: 'ck', type: 'individual' as const, name: 'Carol', email: 'carol@example.org' }]]);
    const sessionAccounts = new Map([['cm', 'mallory@example.org']]);
    const sources = { directory: [bob], remembered, sessionAccounts };
    expect(resolvePrincipal('cj', sources)?.name).toBe('Bob');
    expect(resolvePrincipal('ck', sources)?.name).toBe('Carol');
    expect(resolvePrincipal('cm', sources)).toEqual({ id: 'cm', name: 'mallory@example.org', email: 'mallory@example.org', type: 'individual' });
    expect(resolvePrincipal('zz', sources)).toBeNull();
  });
});

describe('describeSummary', () => {
  const targets: ShareTarget[] = [
    { kind: 'mailbox', accountId: 'ci', id: 'a', name: 'Inbox', role: 'inbox', shareWith: { cj: MAILBOX_PRESETS.read, ck: MAILBOX_PRESETS.readWrite } },
    { kind: 'mailbox', accountId: 'ci', id: 'b', name: 'Sent', role: 'sent', shareWith: { ck: MAILBOX_PRESETS.readWrite } },
    { kind: 'calendar', accountId: 'ci', id: 'c', name: 'Work', isDefault: true, shareWith: { ck: CALENDAR_PRESETS.read } },
    { kind: 'file', accountId: 'ci', id: 'n', name: 'a.pdf', shareWith: { cf: FILE_PRESETS.read } },
  ];
  const [bobSummary, carol, filesOnly] = summarizeDelegates(targets);

  it('says what each person has, in the words of the webmail catalog', () => {
    expect(describeSummary(bobSummary, tEn)).toBe('Inbox · Read');
    expect(describeSummary(carol, tEn)).toBe('All mail folders · 1 calendar · Different rights');
    expect(describeSummary(filesOnly, tEn)).toBe('1 file or folder · Read');
  });
});

describe('the person picker', () => {
  it('never offers the user, and searches names and addresses', () => {
    const me: Principal = { id: 'ci', type: 'individual', name: 'Me', email: 'me@example.org' };
    expect(delegateCandidates([me, bob, team], ['ci'], '').map((p) => p.id)).toEqual(['cj', 'cg']);
    expect(delegateCandidates([me, bob, team], ['ci'], 'TEAM').map((p) => p.id)).toEqual(['cg']);
  });

  it('offers a lookup only for an address nobody listed has', () => {
    expect(canLookUpAddress('dave@example.org', [bob])).toBe(true);
    expect(canLookUpAddress('Bob@example.org', [bob])).toBe(false);
    expect(canLookUpAddress('dave', [])).toBe(false);
  });

  it('turns the lookup into what the dialog shows', () => {
    expect(lookupResult('bob@example.org', { principal: bob, status: 'ok' }, ['ci'])).toEqual({ lookup: { state: 'idle' }, picked: bob });
    expect(lookupResult('me@example.org', { principal: { ...bob, id: 'ci' }, status: 'ok' }, ['ci']).lookup).toEqual({ state: 'self' });
    expect(lookupResult('x@example.org', { principal: null, status: 'forbidden' }, ['ci']).lookup).toEqual({ state: 'directoryOff' });
    expect(lookupResult('x@example.org', { principal: null, status: 'ok' }, ['ci']).lookup).toEqual({ state: 'notFound', address: 'x@example.org' });
    expect(lookupResult('x@example.org', { principal: null, status: 'error' }, ['ci']).lookup).toEqual({ state: 'failed' });
  });
});
