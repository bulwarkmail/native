/**
 * Live checks of contacts and Sieve filters against a real Stalwart server,
 * for what the phone writes: contacts with calendar links, vCard imports and
 * re-imports, address books with cards, the company directory, webmail 1.13+
 * filter scripts (rule periods, vacation forwarding and audience, exact
 * address rules), scripts with if/elsif/else chains and rules made from a
 * message.
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP` and
 * `BULWARK_LIVE_PASS` are set.
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-tablet-dark@example.org BULWARK_LIVE_PASS=… \
 *   npx vitest run src/api/__tests__/live-stalwart-contacts.test.ts
 *
 * Everything it creates is removed again; the account's Sieve scripts are
 * put back as they were, the active one included.
 *
 * Verified against stalwartlabs/stalwart:v0.16.27 and v1.0.0 (2026-10-29).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { JMAPClient } from '../jmap-client';
import {
  createAddressBook,
  deleteAddressBook,
  deleteContacts,
  getAddressBooks,
  getContact,
  createContact,
  updateContact,
} from '../contacts';
import {
  createSieveScript,
  deleteSieveScript,
  getSieveAccountId,
  getSieveCapabilities,
  getSieveScriptContent,
  getSieveScripts,
  updateSieveScript,
  validateSieveScript,
} from '../sieve';
import { updateAccountFilters } from '../sieve-rules';
import { useContactsStore } from '../../stores/contacts-store';
import { readVacationFilters, useFilterStore } from '../../stores/filter-store';
import { generateVCard, parseVCard } from '../../lib/vcard';
import { generateScript } from '../../lib/sieve/generator';
import { parseScript } from '../../lib/sieve/parser';
import { applyQuickRule, buildPresetRule, toRuleMailbox } from '../../lib/sieve/quick-rules';
import { readWebmailFixture, WEBMAIL_FIXTURES } from '../../lib/sieve/__tests__/fixtures/webmail';
import { getMailboxes } from '../email';
import type { ContactCard } from '../types';
import type { SieveScript } from '../../lib/sieve/types';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const live = SERVER && PASS ? describe : describe.skip;

const RUN = Date.now().toString(36);
const SIEVE_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:sieve'];

let client: JMAPClient;
let singleton: JMAPClient;

/** Stalwart 1.0 advertises JMAP Metadata, 0.16 does not. */
const is10 = () => !!client.currentSession?.capabilities?.['urn:ietf:params:jmap:metadata'];

const t = (_key: string, fallback?: string, params?: Record<string, string | number>) =>
  (fallback ?? '').replace(/\{(\w+)\}/g, (_m, k) => String(params?.[k] ?? ''));

live('live Stalwart: contacts and filters (0.16 and 1.0)', () => {
  let bookId = '';
  const createdCards: string[] = [];

  beforeAll(async () => {
    const mod = await import('../jmap-client');
    singleton = mod.jmapClient as unknown as JMAPClient;
    client = new JMAPClient();
    await client.connect(SERVER!, USER, PASS);
    singleton.restoreSnapshot(client.snapshot());
    useContactsStore.getState().reset();
    bookId = (await createAddressBook(`live-contacts-${RUN}`)).id;
  }, 60_000);

  afterAll(async () => {
    if (createdCards.length) await deleteContacts(createdCards).catch(() => undefined);
    const books = await getAddressBooks().catch(() => []);
    for (const book of books.filter((b) => b.name.startsWith(`live-contacts-${RUN}`))) {
      await deleteAddressBook(book.id, undefined, { removeContents: true }).catch(() => undefined);
    }
    useContactsStore.getState().reset();
  }, 60_000);

  describe('contacts', () => {
    // Stalwart refuses calendarUri as a property ("Invalid property.").
    it('saves a contact with calendar, free/busy and scheduling links and reads them back', async () => {
      const card = await createContact({
        '@type': 'Card', version: '1.0', kind: 'individual',
        name: { full: `Live Links ${RUN}` },
        calendarUri: 'https://cal.example.org/anna',
        freeBusyUri: 'https://cal.example.org/anna/fb',
        schedulingUri: 'mailto:anna@example.org',
      } as Partial<ContactCard>, bookId);
      createdCards.push(card.id);
      const back = await getContact(card.id);
      expect(back).toMatchObject({
        calendarUri: 'https://cal.example.org/anna',
        freeBusyUri: 'https://cal.example.org/anna/fb',
        schedulingUri: 'mailto:anna@example.org',
      });

      await updateContact(card.id, { calendarUri: null, freeBusyUri: null, schedulingUri: null } as never);
      const cleared = await getContact(card.id);
      expect(cleared?.calendarUri).toBeUndefined();
      expect(cleared?.schedulingUri).toBeUndefined();
    }, 60_000);

    it('imports a vCard with flat address, label, source and birthplace', async () => {
      const [parsed] = parseVCard([
        'BEGIN:VCARD', 'VERSION:3.0', `FN:Live Import ${RUN}`, `N:Import ${RUN};Live;;;`,
        'ADR;TYPE=HOME;LABEL="Hauptstr. 1, Berlin":;;Hauptstr. 1;Berlin;;10115;Germany',
        'TEL;TYPE=CELL:+49 30 1234',
        'SOURCE:https://dir.example.org/live.vcf',
        'CALURI:https://cal.example.org/live',
        'BDAY:19800102', 'BIRTHPLACE:Hamburg',
        'END:VCARD',
      ].join('\r\n'));
      const result = await useContactsStore.getState().importContacts([parsed], bookId);
      expect(result.failures).toEqual([]);
      expect(result.imported).toBe(1);
      const card = useContactsStore.getState().contacts.find((c) => c.name?.full === `Live Import ${RUN}`);
      createdCards.push(card!.id);
      const back = await getContact(card!.id);
      const address = Object.values(back?.addresses ?? {})[0];
      expect(address?.components?.find((c) => c.kind === 'locality')?.value).toBe('Berlin');
      expect(Object.values(back?.phones ?? {})[0]?.features).toEqual({ mobile: true });
      expect(back?.calendarUri).toBe('https://cal.example.org/live');
      expect(back?.source).toBe('https://dir.example.org/live.vcf');
    }, 60_000);

    // Both servers refuse a second card with the same UID; the import used
    // to count every card of a re-imported export as failed.
    it('re-imports its own vCard 4.0 export by updating the cards', async () => {
      const card = await createContact({
        '@type': 'Card', version: '1.0', kind: 'individual',
        name: { components: [{ kind: 'given', value: 'Live' }, { kind: 'surname', value: `Reimport${RUN}` }], full: `Live Reimport${RUN}` },
        emails: { e: { address: `reimport-${RUN}@example.org` } },
        phones: { p: { number: '+1 555 0100', features: { mobile: true } } },
      } as Partial<ContactCard>, bookId);
      createdCards.push(card.id);
      const vcf = generateVCard([{ ...card, notes: { n: { note: 'from the export' } } }]);
      expect(vcf.startsWith('BEGIN:VCARD\r\nVERSION:4.0\r\n')).toBe(true);
      expect(vcf).toContain('TEL;TYPE=CELL:');

      // A fresh store: the card is not in the list, the server names it.
      // Without the user's say-so the card is left alone.
      useContactsStore.getState().reset();
      const incoming = parseVCard(vcf);
      const refused = await useContactsStore.getState().importContacts(incoming, bookId);
      expect(refused).toMatchObject({ imported: 0, updated: 0, failed: 1 });
      expect((await getContact(card.id))?.notes).toBeUndefined();

      const result = await useContactsStore.getState().importContacts(incoming, bookId, new Set([card.uid!]));
      expect(result).toMatchObject({ imported: 0, updated: 1, failed: 0 });
      const back = await getContact(card.id);
      expect(Object.values(back?.notes ?? {})[0]?.note).toBe('from the export');
    }, 60_000);

    // 1.0 refuses to destroy a book that holds cards without
    // onDestroyRemoveContents (addressBookHasContents).
    it('deletes a category from its contacts and puts it back on Undo', async () => {
      const tag = `live-cat-${RUN}`;
      const one = await createContact({
        '@type': 'Card', version: '1.0', kind: 'individual', name: { full: `Live Cat One ${RUN}` },
        keywords: { [tag]: true, keep: true },
      } as Partial<ContactCard>, bookId);
      const two = await createContact({
        '@type': 'Card', version: '1.0', kind: 'individual', name: { full: `Live Cat Two ${RUN}` },
        keywords: { [tag]: true },
      } as Partial<ContactCard>, bookId);
      createdCards.push(one.id, two.id);
      await useContactsStore.getState().fetchContacts();

      const ids = await useContactsStore.getState().removeKeyword(tag);
      expect(ids.sort()).toEqual([one.id, two.id].sort());
      expect((await getContact(one.id))?.keywords ?? {}).toEqual({ keep: true });
      expect((await getContact(two.id))?.keywords?.[tag]).toBeFalsy();

      await useContactsStore.getState().addKeyword(tag, ids);
      expect((await getContact(one.id))?.keywords).toEqual({ [tag]: true, keep: true });
      expect((await getContact(two.id))?.keywords).toEqual({ [tag]: true });
    }, 60_000);

    it('deletes an address book that still holds contacts', async () => {
      const book = await createAddressBook(`live-contacts-${RUN}-full`);
      const card = await createContact({ '@type': 'Card', version: '1.0', name: { full: `Live Book ${RUN}` } } as Partial<ContactCard>, book.id);
      useContactsStore.setState({ addressBooks: [book], contacts: [card] });
      await useContactsStore.getState().deleteAddressBook(book.id);
      expect((await getAddressBooks()).some((b) => b.id === book.id)).toBe(false);
      expect(await getContact(card.id)).toBeNull();
    }, 60_000);

    it('lists the directory, saying so when the server keeps it restricted', async () => {
      useContactsStore.getState().reset();
      await useContactsStore.getState().fetchDirectory();
      const s = useContactsStore.getState();
      if (is10()) {
        // Directory queries are off by default on 1.0.
        expect(s.directoryStatus).toBe('restricted');
        expect(s.directoryQueriesOff).toBe(true);
      } else {
        expect(['ready', 'restricted']).toContain(s.directoryStatus);
      }
      expect(s.directory.some((e) => e.email.toLowerCase() === USER.toLowerCase())).toBe(true);
      expect(s.lookupDirectory(USER.split('@')[0]).map((r) => r.email.toLowerCase())).toContain(USER.toLowerCase());
    }, 60_000);
  });

  describe('filters', () => {
    let before: Array<SieveScript & { content: string }> = [];
    let created: string | null = null;

    beforeAll(async () => {
      // What the account has, to put back afterwards.
      const scripts = await getSieveScripts();
      before = [];
      for (const s of scripts) before.push({ ...s, content: await getSieveScriptContent(s.blobId) });
    }, 60_000);

    afterAll(async () => {
      const accountId = getSieveAccountId();
      const now = await getSieveScripts().catch(() => [] as SieveScript[]);
      // An active script cannot be destroyed (RFC 9661): switch them all off first.
      await client.request([['SieveScript/set', { accountId, onSuccessDeactivateScript: true }, '0']], SIEVE_USING)
        .catch(() => undefined);
      for (const s of now) {
        const old = before.find((b) => b.id === s.id);
        if (!old) await deleteSieveScript(s.id).catch(() => undefined);
        else if ((await getSieveScriptContent(s.blobId).catch(() => old.content)) !== old.content) {
          await updateSieveScript(s.id, old.content, false).catch(() => undefined);
        }
      }
      const active = before.find((b) => b.isActive);
      if (active) {
        await client.request([['SieveScript/set', { accountId, onSuccessActivateScript: active.id }, '0']], SIEVE_USING)
          .catch(() => undefined);
      }
      const after = await getSieveScripts();
      expect(after.map((s) => [s.id, s.isActive]).sort()).toEqual(before.map((s) => [s.id, s.isActive]).sort());
      useFilterStore.getState().clearState();
    }, 60_000);

    it('compiles every webmail fixture', async () => {
      for (const { file } of WEBMAIL_FIXTURES) {
        const result = await validateSieveScript(readWebmailFixture(file));
        expect({ file, ...result }).toEqual({ file, isValid: true });
      }
    }, 60_000);

    // #1152: version 2 opened as raw Sieve, and a save dropped the periods,
    // the forwarding and the audience.
    it('edits a webmail 1.13 script as rules and saves it back whole', async () => {
      const fixture = readWebmailFixture('period-forward-audience.sieve');
      const script = await createSieveScript(`live-filters-${RUN}`, fixture, true);
      created = script.id;

      await useFilterStore.getState().selectAccount(null);
      const s = useFilterStore.getState();
      expect(s.activeScriptId).toBe(script.id);
      expect(s.isOpaque).toBe(false);
      expect(s.rules.map((r) => r.activeFrom)).toEqual(['2026-11-02T07:00:00.000Z', '2026-12-01T00:00:00.000Z']);
      expect(s.vacationForward?.to).toBe('backup@example.org');
      expect(s.vacationAudience?.only).toBe('internal');

      await useFilterStore.getState().saveFilters();
      const saved = (await getSieveScripts()).find((x) => x.id === script.id)!;
      const content = await getSieveScriptContent(saved.blobId);
      const parsed = parseScript(fixture);
      expect(content).toBe(generateScript(parsed.rules, parsed.vacation, {
        externalRequires: parsed.externalRequires,
        includeVacation: parsed.includeVacation,
        vacationForward: parsed.vacationForward,
        vacationAudience: parsed.vacationAudience,
        extensions: getSieveCapabilities()?.sieveExtensions,
      }));
      expect(parseScript(content).vacationForward).toEqual(parsed.vacationForward);

      const vacation = await readVacationFilters();
      expect(vacation.forward?.to).toBe('backup@example.org');
      expect(vacation.audience?.domains).toEqual(['example.org', 'example.com']);
      expect(vacation.forwardAvailable).toBe(true);
      expect(vacation.audienceAvailable).toBe(true);
    }, 60_000);

    it('adds a rule made from a message to the top, as an exact address test', async () => {
      const mailboxes = await getMailboxes();
      const inbox = mailboxes.find((m) => m.role === 'inbox')!;
      const subject = { senders: [{ email: `sender-${RUN}@example.net` }], domain: null, listId: null };
      const rule = buildPresetRule({ kind: 'move_sender', mailbox: toRuleMailbox(mailboxes, inbox) }, subject, t, `quick-${RUN}`);
      expect(await updateAccountFilters((rules) => {
        const outcome = applyQuickRule(rules, rule);
        return outcome.kind === 'covered' ? null : outcome.rules;
      })).toBe(true);

      const active = (await getSieveScripts()).find((x) => x.isActive)!;
      expect(active.id).toBe(created);
      const content = await getSieveScriptContent(active.blobId);
      expect(content).toContain(`if allof(address :is "From" "sender-${RUN}@example.net", not spamtest`);
      const back = parseScript(content);
      expect(back.rules[0].id).toBe(`quick-${RUN}`);
      // The rule went in without losing what the vacation card set.
      expect(back.vacationForward?.to).toBe('backup@example.org');
    }, 60_000);

    // A save cut elsif/else at their first ";" and the server refused the
    // script ("Unterminated block").
    it('saves a script with if/elsif/else chains back as one the server takes', async () => {
      for (const file of ['hand-written-elsif.sieve', 'category-tabs.sieve']) {
        const fixture = readFileSync(join(__dirname, '../../lib/sieve/__tests__/fixtures', file), 'utf-8')
          .replace(/\r\n/g, '\n');
        expect({ file, ...(await validateSieveScript(fixture)) }).toEqual({ file, isValid: true });

        await updateSieveScript(created!, fixture, true);
        await useFilterStore.getState().selectAccount(null);
        expect(useFilterStore.getState().isOpaque).toBe(false);
        await useFilterStore.getState().saveFilters();
        expect(useFilterStore.getState().error).toBeNull();

        const saved = (await getSieveScripts()).find((x) => x.id === created)!;
        const content = await getSieveScriptContent(saved.blobId);
        const chain = file === 'category-tabs.sieve' ? '# BEGIN category-tabs' : '# Sorted by hand';
        expect(content).toContain(fixture.slice(fixture.indexOf(chain)).trim());
        expect({ file, ...(await validateSieveScript(content)) }).toEqual({ file, isValid: true });
      }
    }, 60_000);
  });
});
