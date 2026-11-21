// An Android account per synced address book (#155; docs/device-sync.md,
// "Account type and accounts"): the app account's own account keeps the
// books' accounts, each book's account syncs that book alone.

import { describe, expect, it } from 'vitest';
import { Data, MimeType } from '../../android-columns';
import { addressBookAccountName } from '../../engine/address-books';
import { summarizeRuns } from '../../engine/report';
import { teardownAuthority } from '../../engine/teardown';
import type { RunStatus } from '../../types';
import {
  addDeviceContact,
  addServerCards,
  ANDROID_ACCOUNT,
  CONTACTS_AUTHORITY,
  createHarness,
  REGISTRY_ID,
  renameDeviceContact,
  type Harness,
} from './harness';

const PERSONAL = `${ANDROID_ACCOUNT} – Personal`;
const FLAT = `${ANDROID_ACCOUNT} – Flat`;

/** A harness with a second address book, and a source per book turned on. */
function separated(options: Parameters<typeof createHarness>[0] = {}): { h: Harness; flat: string; keys: { personal: string; flat: string } } {
  const h = createHarness(options);
  const flat = h.server.addAddressBook('a', { name: 'Flat' });
  h.prefs.separateAddressBooks = true;
  return { h, flat, keys: { personal: `a/${h.book}`, flat: `a/${flat}` } };
}

/** The names of the contacts an Android account holds. */
function namesIn(h: Harness, accountName: string): string[] {
  return h
    .contacts()
    .filter((c) => c.row.account_name === accountName && !c.deleted)
    .map((c) => c.name ?? '')
    .sort();
}

/** The own account's sync, then the syncs it asked for. */
async function syncAll(h: Harness): Promise<void> {
  h.syncRequests.length = 0;
  await h.run();
  for (const { name } of [...h.syncRequests]) {
    const account = h.androidAccounts.find((a) => a.name === name);
    if (account?.collection) await h.runBook(account.collection);
  }
}

function bookAccounts(h: Harness): string[] {
  return h.androidAccounts.filter((a) => a.collection).map((a) => a.name).sort();
}

describe('device sync engine: an Android account per address book', () => {
  it('gives every synced address book an account, and each account that book alone', async () => {
    const { h, flat, keys } = separated();
    h.server.addAddressBook('a', { name: 'Trusted Senders' });
    addServerCards(h, ['Ada', 'Grace']);
    addServerCards(h, ['Linus'], 'a', flat);

    const report = await h.run();

    expect(report.outcome).toBe('ok');
    expect(h.androidAccounts).toEqual([
      { name: ANDROID_ACCOUNT, registryId: REGISTRY_ID },
      { name: PERSONAL, registryId: REGISTRY_ID, collection: keys.personal },
      { name: FLAT, registryId: REGISTRY_ID, collection: keys.flat },
    ]);
    expect(h.prefs.addressBookAccounts).toEqual({ [keys.personal]: PERSONAL, [keys.flat]: FLAT });
    expect(h.syncRequests.map((r) => r.name)).toEqual([PERSONAL, FLAT]);
    // The own account holds no contacts.
    expect(h.contacts()).toEqual([]);

    await h.runBook(keys.personal);
    await h.runBook(keys.flat);

    expect(namesIn(h, PERSONAL)).toEqual(['Ada', 'Grace']);
    expect(namesIn(h, FLAT)).toEqual(['Linus']);
    expect(namesIn(h, ANDROID_ACCOUNT)).toEqual([]);
    expect(h.device.readSyncState(ANDROID_ACCOUNT, CONTACTS_AUTHORITY)).toBeFalsy();
  });

  it('shows a card that is in two synced books in the account of each', async () => {
    const { h, flat, keys } = separated();
    h.server.addCard('a', { uid: 'uid-both', name: { full: 'Hedy' }, addressBookIds: { [h.book]: true, [flat]: true } });

    await syncAll(h);

    expect(namesIn(h, PERSONAL)).toEqual(['Hedy']);
    expect(namesIn(h, FLAT)).toEqual(['Hedy']);

    // An edit in one account reaches the other with its next sync, and uploads once.
    const inFlat = h.contacts().find((c) => c.row.account_name === FLAT)!;
    renameDeviceContact(h, inFlat.id, 'Hedy Lamarr');
    await h.runBook(keys.flat);
    await h.runBook(keys.personal);

    expect(h.serverNames()).toEqual(['Hedy Lamarr']);
    expect(namesIn(h, PERSONAL)).toEqual(['Hedy Lamarr']);
    expect(h.contacts().some((c) => c.dirty)).toBe(false);
  });

  it('creates a contact made in a book\'s account in that book', async () => {
    const { h, flat, keys } = separated();
    await syncAll(h);

    h.device.user.insertContact(FLAT, [{ [Data.MIMETYPE]: MimeType.STRUCTURED_NAME, [Data.DATA1]: 'Katherine' }]);
    await h.runBook(keys.flat);

    const card = h.server.all('ContactCard', 'a').find((c) => (c.name as { full?: string }).full === 'Katherine');
    expect(card?.addressBookIds).toEqual({ [flat]: true });
    expect(namesIn(h, FLAT)).toEqual(['Katherine']);
  });

  it('moves contacts the own account synced before into the books\' accounts, uploading its changes first', async () => {
    const h = createHarness();
    const flat = h.server.addAddressBook('a', { name: 'Flat' });
    addServerCards(h, ['Ada']);
    addServerCards(h, ['Linus'], 'a', flat);
    await h.run();
    expect(namesIn(h, ANDROID_ACCOUNT)).toEqual(['Ada', 'Linus']);
    renameDeviceContact(h, h.contactNamed('Ada')!.id, 'Ada King');
    addDeviceContact(h, 'Hedy');

    h.prefs.separateAddressBooks = true;
    await syncAll(h);

    expect(h.serverNames()).toEqual(['Ada King', 'Hedy', 'Linus']);
    expect(namesIn(h, ANDROID_ACCOUNT)).toEqual([]);
    expect(h.device.readSyncState(ANDROID_ACCOUNT, CONTACTS_AUTHORITY)).toBeFalsy();
    expect(namesIn(h, PERSONAL)).toEqual(['Ada King', 'Hedy']);
    expect(namesIn(h, FLAT)).toEqual(['Linus']);
  });

  it('keeps the own account\'s contacts, and makes no book accounts, while a change cannot be uploaded', async () => {
    const h = createHarness();
    addServerCards(h, ['Ada']);
    await h.run();
    renameDeviceContact(h, h.contactNamed('Ada')!.id, 'Ada King');
    h.server.failNextRequest('network');

    h.prefs.separateAddressBooks = true;
    const report = await h.run();

    expect(report.itemErrors).toEqual([expect.objectContaining({ ref: ANDROID_ACCOUNT, type: 'pendingChanges' })]);
    expect(namesIn(h, ANDROID_ACCOUNT)).toEqual(['Ada King']);
    expect(bookAccounts(h)).toEqual([]);
    expect(h.syncRequests).toEqual([]);
  });

  it('keeps the books syncing, and its own status current, while a contact made in the own account cannot be uploaded', async () => {
    const { h } = separated();
    await syncAll(h);
    addDeviceContact(h, 'Hedy');
    h.server.failNextRequest('network');
    h.syncRequests.length = 0;

    const stuck = await h.run();

    expect(stuck.itemErrors).toEqual([expect.objectContaining({ type: 'pendingChanges' })]);
    expect(h.syncRequests.map((r) => r.name)).toEqual([PERSONAL, FLAT]);
    expect(h.lastStatus(CONTACTS_AUTHORITY, ANDROID_ACCOUNT)?.itemErrors).toBe(1);

    await syncAll(h);

    expect(h.serverNames()).toEqual(['Hedy']);
    expect(namesIn(h, PERSONAL)).toEqual(['Hedy']);
    expect(h.lastStatus(CONTACTS_AUTHORITY, ANDROID_ACCOUNT)?.itemErrors).toBe(0);
  });

  it('takes a card deleted in a book\'s account out of that book only, also when the book is deselected before the upload', async () => {
    const { h, flat, keys } = separated();
    const both = h.server.addCard('a', { uid: 'uid-both', name: { full: 'Hedy' }, addressBookIds: { [h.book]: true, [flat]: true } });
    await syncAll(h);

    h.device.user.deleteContact(h.contacts().find((c) => c.row.account_name === FLAT)!.id);
    h.prefs.contactsSelection[keys.flat] = false;
    await syncAll(h);

    expect(bookAccounts(h)).toEqual([PERSONAL]);
    expect(h.server.all('ContactCard', 'a').find((c) => c.id === both)?.addressBookIds).toEqual({ [h.book]: true });
    expect(namesIn(h, PERSONAL)).toEqual(['Hedy']);
  });

  it('uploads what a deselected book\'s account still holds, then removes the account', async () => {
    const { h, flat, keys } = separated();
    addServerCards(h, ['Linus'], 'a', flat);
    await syncAll(h);
    renameDeviceContact(h, h.contactNamed('Linus')!.id, 'Linus T');
    h.device.user.insertContact(FLAT, [{ [Data.MIMETYPE]: MimeType.STRUCTURED_NAME, [Data.DATA1]: 'Katherine' }]);

    h.prefs.contactsSelection[keys.flat] = false;
    await syncAll(h);

    expect(h.serverNames()).toEqual(['Katherine', 'Linus T']);
    expect(h.server.all('ContactCard', 'a').every((c) => (c.addressBookIds as Record<string, boolean>)[flat])).toBe(true);
    expect(bookAccounts(h)).toEqual([PERSONAL]);
    expect(h.prefs.addressBookAccounts).toEqual({ [keys.personal]: PERSONAL });
    expect(namesIn(h, FLAT)).toEqual([]);
  });

  it('removes the account of an address book deleted on the server', async () => {
    const { h, flat } = separated();
    addServerCards(h, ['Linus'], 'a', flat);
    await syncAll(h);

    for (const card of h.server.all('ContactCard', 'a')) h.server.serverDestroy('ContactCard', 'a', String(card.id));
    h.server.serverDestroy('AddressBook', 'a', flat);
    await syncAll(h);

    expect(bookAccounts(h)).toEqual([PERSONAL]);
  });

  it('stops syncing a book whose account was removed in Android Settings instead of bringing it back', async () => {
    const { h, keys } = separated();
    await syncAll(h);

    await h.deps.accounts.remove(FLAT);
    // The app only remembers what the engine recorded: the removal was not the engine's.
    expect(h.prefs.addressBookAccounts?.[keys.flat]).toBe(FLAT);
    await syncAll(h);

    expect(bookAccounts(h)).toEqual([PERSONAL]);
    expect(h.prefs.contactsSelection[keys.flat]).toBe(false);
    expect(h.prefs.addressBookAccounts).toEqual({ [keys.personal]: PERSONAL });
  });

  it('folds the books\' accounts back into the own account when the setting is turned off', async () => {
    const { h, flat, keys } = separated();
    addServerCards(h, ['Ada']);
    addServerCards(h, ['Linus'], 'a', flat);
    await syncAll(h);
    renameDeviceContact(h, h.contactNamed('Linus')!.id, 'Linus T');

    h.prefs.separateAddressBooks = false;
    // A book's account no longer syncs on its own.
    expect((await h.runBook(keys.flat)).outcome).toBe('disabled');
    const report = await h.run();

    expect(report.outcome).toBe('ok');
    expect(bookAccounts(h)).toEqual([]);
    expect(h.prefs.addressBookAccounts).toEqual({});
    expect(h.serverNames()).toEqual(['Ada', 'Linus T']);
    expect(namesIn(h, ANDROID_ACCOUNT)).toEqual(['Ada', 'Linus T']);
  });

  it('pauses the books\' accounts with the own account', async () => {
    const { h, keys } = separated();
    await syncAll(h);

    h.paused.add(ANDROID_ACCOUNT);

    expect((await h.runBook(keys.personal)).outcome).toBe('disabled');
    expect((await h.run()).outcome).toBe('disabled');
  });

  it('names a shared account\'s book after its owner, and leaves the accounts of a refusing account alone', async () => {
    const h = createHarness({ accounts: 'withShared' });
    h.prefs.separateAddressBooks = true;
    const team = h.server.all('AddressBook', 'team')[0];
    const teamKey = `team/${String(team.id)}`;
    h.prefs.contactsSelection[teamKey] = true;
    await syncAll(h);

    const teamAccount = `${ANDROID_ACCOUNT} – Team contacts (Team)`;
    expect(bookAccounts(h)).toEqual([PERSONAL, teamAccount].sort());

    h.server.failNextMethod('AddressBook/get', { type: 'forbidden' }, { accountId: 'team' });
    await h.run();

    expect(bookAccounts(h)).toEqual([PERSONAL, teamAccount].sort());
  });

  it('hands a manual or expedited request on to the books\' accounts', async () => {
    const { h } = separated();
    await h.run(CONTACTS_AUTHORITY, { manual: true, expedited: true });

    expect(h.syncRequests).toEqual([
      { name: PERSONAL, options: expect.objectContaining({ manual: true, expedited: true }) },
      { name: FLAT, options: expect.objectContaining({ manual: true, expedited: true }) },
    ]);
  });

  it('asks for no syncs on the upload sync Android starts for every account after an app write', async () => {
    const { h } = separated();
    await syncAll(h);
    h.syncRequests.length = 0;

    await h.run(CONTACTS_AUTHORITY, { upload: true });

    expect(h.syncRequests).toEqual([]);
  });

  it('records each account\'s run apart', async () => {
    const { h } = separated();
    addServerCards(h, ['Ada']);
    await syncAll(h);

    expect(h.lastStatus(CONTACTS_AUTHORITY, PERSONAL)?.stats.downloaded.created).toBe(1);
    expect(h.lastStatus(CONTACTS_AUTHORITY, FLAT)?.stats.downloaded.created).toBe(0);
    expect(h.lastStatus(CONTACTS_AUTHORITY)).toBeUndefined();
    // The echo skip is the app account's: one book's state says nothing about the others.
    expect(h.deps.recordKnownState).not.toHaveBeenCalledWith(REGISTRY_ID, 'a', 'ContactCard', expect.anything());
  });

  it('uploads into the book when the app empties a book\'s account (sync turned off)', async () => {
    const { h, flat } = separated();
    await syncAll(h);
    h.device.user.insertContact(FLAT, [{ [Data.MIMETYPE]: MimeType.STRUCTURED_NAME, [Data.DATA1]: 'Katherine' }]);

    const result = await teardownAuthority(h.deps, REGISTRY_ID, FLAT, CONTACTS_AUTHORITY);

    expect(result).toEqual({ pending: 0 });
    expect(h.server.all('ContactCard', 'a')[0].addressBookIds).toEqual({ [flat]: true });
    expect(namesIn(h, FLAT)).toEqual([]);
  });
});

describe('addressBookAccountName', () => {
  const personal = { name: 'alice@example.com', primary: true };

  it('joins the login and the book, and numbers a name that is taken', () => {
    expect(addressBookAccountName('alice@example.com', { name: 'Flat', account: personal }, new Set())).toBe('alice@example.com – Flat');
    expect(
      addressBookAccountName('alice@example.com', { name: 'Flat', account: personal }, new Set(['alice@example.com – Flat'])),
    ).toBe('alice@example.com – Flat (2)');
  });
});

describe('summarizeRuns', () => {
  const run = (at: number, patch: Partial<RunStatus> = {}): RunStatus => ({
    at,
    outcome: 'ok',
    durationMs: 1,
    conflicts: 0,
    itemErrors: 0,
    stats: { downloaded: { created: 0, updated: 0, deleted: 0 }, uploaded: { created: 0, updated: 0, deleted: 0 }, entries: 0, skipped: 0 },
    ...patch,
  });

  it('shows a failed account over later ones that synced, then one with something to report, then the latest', () => {
    const failed = run(1, { outcome: 'io', message: 'offline' });
    const noted = run(2, { itemErrors: 1 });
    expect(summarizeRuns([failed, noted, run(3)])).toBe(failed);
    expect(summarizeRuns([noted, run(3), run(4, { outcome: 'disabled' })])).toBe(noted);
    expect(summarizeRuns([run(3), run(5), run(4)])?.at).toBe(5);
    expect(summarizeRuns([])).toBeUndefined();
  });
});
