/**
 * Live checks of "Search everything" against a real Stalwart: one word finds
 * a message, a contact, an event and a folder of the signed-in login, and a
 * contact of a second login that is searched "detached", with its stored
 * credentials, while the first stays connected.
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP`,
 * `BULWARK_LIVE_PASS` and `BULWARK_LIVE_USER2` are set (`BULWARK_LIVE_PASS2`
 * defaults to the first password).
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-perf@example.org BULWARK_LIVE_PASS=… \
 *   BULWARK_LIVE_USER2=e2e-tablet-land@example.org \
 *   npx vitest run src/api/__tests__/live-stalwart-global-search.test.ts
 *
 * Everything the run makes is removed again, also after a failed check.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const { secrets } = vi.hoisted(() => ({ secrets: new Map<string, string>() }));
vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
  getItemAsync: vi.fn(async (key: string) => secrets.get(key) ?? null),
  deleteItemAsync: vi.fn(async (key: string) => { secrets.delete(key); }),
}));

import { JMAPClient, credentialsKey } from '../jmap-client';
import { CAPABILITIES } from '../types';
import { GLOBAL_SEARCH_PROVIDERS, resetGlobalSearchCache } from '../global-search';
import { runGlobalSearch } from '../../lib/global-search/run';
import { parseSearchQuery } from '../../lib/global-search/query-parser';
import type { SearchAccount, SearchOutcome } from '../../lib/global-search/types';
import { generateAccountId } from '../../lib/account-utils';
import { createFolder, deleteFileNodes } from '../files';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const USER2 = process.env.BULWARK_LIVE_USER2;
const PASS2 = process.env.BULWARK_LIVE_PASS2 ?? PASS;
const live = SERVER && PASS && USER2 ? describe : describe.skip;

// One word nobody else has, so the full-text index finds only this run.
const TOKEN = `qz${Date.now().toString(36)}`;

type Responses = Array<[string, Record<string, any>, string]>;

let owner: JMAPClient;
let second: JMAPClient;
const made: Array<{ client: () => JMAPClient; method: string; accountId: string; id: string; using: string[] }> = [];

async function call(client: JMAPClient, calls: unknown[], using: string[]): Promise<Responses> {
  return (await client.request(calls as never, using)).methodResponses as Responses;
}

async function createOne(client: JMAPClient, method: string, accountId: string, object: Record<string, unknown>, using: string[]): Promise<string> {
  const [[name, body]] = await call(client, [[method, { accountId, create: { x: object } }, '0']], using);
  expect(name, JSON.stringify(body)).toBe(method);
  const id = body.created?.x?.id as string | undefined;
  expect(id, JSON.stringify(body.notCreated)).toBeTruthy();
  made.push({ client: () => client, method, accountId, id: id!, using });
  return id!;
}

async function seedContact(client: JMAPClient): Promise<string> {
  const accountId = client.currentSession!.primaryAccounts[CAPABILITIES.CONTACTS];
  const using = [CAPABILITIES.CORE, CAPABILITIES.CONTACTS];
  const [[, books]] = await call(client, [['AddressBook/get', { accountId, properties: ['id', 'isDefault'] }, '0']], using);
  const book = (books.list as { id: string; isDefault?: boolean }[]).find((b) => b.isDefault) ?? books.list[0];
  return createOne(client, 'ContactCard/set', accountId, {
    '@type': 'Card', version: '1.0', kind: 'individual', addressBookIds: { [book.id]: true },
    uid: `urn:uuid:${TOKEN}-${client.username}`,
    // 0.16 finds a card by the words of its name components, not of `full`.
    name: { components: [{ kind: 'given', value: 'Findme' }, { kind: 'surname', value: TOKEN }], isOrdered: true, full: `Findme ${TOKEN}` },
  }, using);
}

const accountFor = (user: string, active: boolean): SearchAccount => ({
  localAccountId: generateAccountId(user, SERVER!), label: user, email: user, serverUrl: SERVER, active,
});

async function search(accounts: SearchAccount[]): Promise<SearchOutcome> {
  return runGlobalSearch({
    parsed: parseSearchQuery(TOKEN), accounts, providers: GLOBAL_SEARCH_PROVIDERS,
    localLimit: 10, remoteLimit: 25, signal: new AbortController().signal, onUpdate: () => undefined, timeoutMs: 20_000,
  });
}

live('live Stalwart: search everything', () => {
  let ids: { mail: string; contact: string; event: string; folder: string | null; secondContact: string };

  beforeAll(async () => {
    const mod = await import('../jmap-client');
    owner = new JMAPClient();
    await owner.connect(SERVER!, USER, PASS);
    (mod.jmapClient as unknown as JMAPClient).restoreSnapshot(owner.snapshot());
    second = new JMAPClient();
    await second.connect(SERVER!, USER2!, PASS2);
    // The second login is searched with what the app keeps in secure storage.
    secrets.set(credentialsKey(generateAccountId(USER2!, SERVER!)), JSON.stringify({ serverUrl: SERVER, username: USER2, password: PASS2 }));
    resetGlobalSearchCache();

    const mailAccount = owner.accountId;
    const mailUsing = [CAPABILITIES.CORE, CAPABILITIES.MAIL];
    const [[, drafts]] = await call(owner, [['Mailbox/query', { accountId: mailAccount, filter: { role: 'drafts' } }, '0']], mailUsing);
    const mail = await createOne(owner, 'Email/set', mailAccount, {
      mailboxIds: { [drafts.ids[0]]: true }, keywords: { $draft: true, $seen: true },
      from: [{ email: USER }], subject: `Findme ${TOKEN}`,
      bodyValues: { b: { value: 'search check' } }, textBody: [{ partId: 'b', type: 'text/plain' }],
    }, mailUsing);
    const contact = await seedContact(owner);

    const calAccount = owner.currentSession!.primaryAccounts[CAPABILITIES.CALENDARS];
    const calUsing = [CAPABILITIES.CORE, CAPABILITIES.CALENDARS];
    const [[, calendars]] = await call(owner, [['Calendar/get', { accountId: calAccount, properties: ['id', 'isDefault'] }, '0']], calUsing);
    const calendar = (calendars.list as { id: string; isDefault?: boolean }[]).find((c) => c.isDefault) ?? calendars.list[0];
    const event = await createOne(owner, 'CalendarEvent/set', calAccount, {
      '@type': 'Event', calendarIds: { [calendar.id]: true }, title: `Findme ${TOKEN}`,
      start: '2027-06-01T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin',
    }, calUsing);

    let folder: string | null = null;
    if (owner.currentSession!.capabilities[CAPABILITIES.FILES]) {
      // The app's own call: 1.0 wants the draft's @type, 0.16 refuses it.
      folder = (await createFolder(`findme-${TOKEN}`, null)).id;
    }
    const secondContact = await seedContact(second);
    ids = { mail, contact, event, folder, secondContact };
  }, 90_000);

  afterAll(async () => {
    if (ids?.folder) await deleteFileNodes([ids.folder]).catch(() => undefined);
    for (const item of made.reverse()) {
      await call(item.client(), [[item.method, { accountId: item.accountId, destroy: [item.id] }, '0']], item.using).catch(() => undefined);
    }
  }, 60_000);

  it('finds the message, contact, event and folder of the signed-in login and the contact of the other one', async () => {
    const accounts = [accountFor(USER, true), accountFor(USER2!, false)];
    // The full-text index lags a little behind a write.
    let outcome = await search(accounts);
    for (let i = 0; i < 15; i++) {
      const found = outcome.hits.mail.some((h) => h.id === ids.mail)
        && outcome.hits.calendar.some((h) => h.id === ids.event)
        && outcome.hits.contacts.filter((h) => h.id === ids.contact || h.id === ids.secondContact).length === 2;
      if (found) break;
      await new Promise((r) => setTimeout(r, 2000));
      outcome = await search(accounts);
    }
    for (const kind of ['mail', 'contacts', 'calendar', 'files'] as const) expect(outcome.status[kind].errors, kind).toEqual([]);

    const mail = outcome.hits.mail.find((h) => h.id === ids.mail);
    expect(mail?.localAccountId).toBe(accounts[0].localAccountId);
    expect(outcome.hits.calendar.find((h) => h.id === ids.event)?.title).toBe(`Findme ${TOKEN}`);
    const contacts = outcome.hits.contacts.filter((h) => h.id === ids.contact || h.id === ids.secondContact);
    expect(contacts.map((h) => h.localAccountId).sort()).toEqual(accounts.map((a) => a.localAccountId).sort());
    if (ids.folder) {
      const folder = outcome.hits.files.find((h) => h.id === ids.folder);
      expect(folder).toMatchObject({ isFolder: true, folderPath: '/' });
    }
  }, 120_000);

  it('keeps to the account picked with account: and the kind picked with in:', async () => {
    const accounts = [accountFor(USER, true), accountFor(USER2!, false)];
    const outcome = await runGlobalSearch({
      parsed: parseSearchQuery(`in:contacts account:${USER2} ${TOKEN}`), accounts, providers: GLOBAL_SEARCH_PROVIDERS,
      localLimit: 10, remoteLimit: 25, signal: new AbortController().signal, onUpdate: () => undefined, timeoutMs: 20_000,
    });
    expect(outcome.hits.mail).toEqual([]);
    expect(outcome.hits.contacts.map((h) => h.localAccountId)).toEqual([accounts[1].localAccountId]);
  }, 60_000);
});
