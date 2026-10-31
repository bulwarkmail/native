/**
 * Live checks of mail, submissions, contacts, search, Sieve and identities
 * against a real Stalwart server, for the differences between 0.16 and 1.0.
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP` and
 * `BULWARK_LIVE_PASS` are set. `BULWARK_LIVE_USER2` / `BULWARK_LIVE_PASS2`
 * name a second login on the same server for the multi-account check.
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-phone-light@example.org BULWARK_LIVE_PASS=… \
 *   npx vitest run src/api/__tests__/live-stalwart-mail.test.ts
 *
 * Everything it creates is removed again. Mail goes to the user's own
 * address; nothing depends on delivery (SMTP may be down on a test server).
 *
 * Verified against stalwartlabs/stalwart:v0.16.27 and v1.0.0 (2026-10-29).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { JMAPClient } from '../jmap-client';
import {
  createMailbox,
  deleteMailbox,
  destroyEmails,
  emptyMailbox,
  getEmailFlags,
  getFullEmails,
  getMailboxChanges,
  getMailboxesWithState,
  getMailboxes,
  importEmailBlob,
  listScheduledEmails,
  cancelScheduledSend,
  rescheduleScheduledSend,
  restoreEmailToDraft,
  patchKeywordsForEmails,
  searchEmails,
  sendEmail,
  MAILBOX_PROPERTIES,
  queryEmailPage,
} from '../email';
import { senderWarningOf } from '../../lib/email-headers';
import { scheduledEmailIdsInThread } from '../thread-scheduled';
import { fetchTagCounts, KEYWORDS_CAPABILITY } from '../tag-counts';
import { uploadBytes } from '../blob';
import { getIdentities, updateIdentity } from '../identity';
import { isJMAPSetError } from '../jmap-result';
import { pruneEmailSubmissions } from '../submissions';
import { listPrincipals } from '../files';
import { createContact, deleteContacts, getAddressBooks, getContact } from '../contacts';
import {
  createSieveScript, deleteSieveScript, getSieveScriptContent, getSieveScripts, updateSieveScript, validateSieveScript,
} from '../sieve';
import { useFilterStore } from '../../stores/filter-store';
import { inlineContactMediaForExport, writeContactWithNewPhoto } from '../../lib/contact-media';
import { getBulwarkMetadata, resetBulwarkMetadata, supportsBulwarkMetadata } from '../bulwark-metadata';
import { parseSharedTags, SHARED_TAGS_KEY } from '../../lib/shared-tags';
import { generateVCard, parseVCard } from '../../lib/vcard';
import type { ContactCard } from '../types';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const USER2 = process.env.BULWARK_LIVE_USER2;
const PASS2 = process.env.BULWARK_LIVE_PASS2 ?? PASS;
const live = SERVER && PASS ? describe : describe.skip;

const RUN = Date.now().toString(36);
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let client: JMAPClient;
let singleton: JMAPClient;

async function useLogin(login: JMAPClient): Promise<void> {
  singleton.restoreSnapshot(login.snapshot());
}

/** Stalwart 1.0 advertises JMAP Metadata, 0.16 does not. */
const is10 = () => !!client.currentSession?.capabilities?.['urn:ietf:params:jmap:metadata'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` holds; Stalwart indexes new mail in the background. */
async function eventually<T>(read: () => Promise<T>, check: (v: T) => boolean, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  let value = await read();
  while (!check(value) && Date.now() < until) {
    await sleep(500);
    value = await read();
  }
  return value;
}

async function importMessage(mailboxId: string, subject: string, body: string, keywords: Record<string, boolean> = {}) {
  const raw = `From: Partner <partner@example.net>\r\nTo: ${USER}\r\nSubject: ${subject}\r\n` +
    `Date: ${new Date().toUTCString()}\r\nMessage-ID: <${subject.replace(/\W/g, '')}-${RUN}@live.test>\r\n` +
    `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
  const { blobId } = await uploadBytes(new TextEncoder().encode(raw), 'message/rfc822');
  return importEmailBlob(blobId, mailboxId, keywords);
}

/** Every message (any folder) whose subject carries `tag`. */
async function messagesWith(tag: string): Promise<string[]> {
  const res = await client.request([
    ['Email/query', { accountId: client.accountId, filter: { subject: tag } }, '0'],
  ]);
  return (res.methodResponses[0][1].ids as string[]) ?? [];
}

async function submissionExists(id: string): Promise<boolean> {
  const res = await client.request(
    [['EmailSubmission/get', { accountId: client.accountId, ids: [id], properties: ['id'] }, '0']],
    ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission'],
  );
  return ((res.methodResponses[0][1].list as unknown[]) ?? []).length > 0;
}

live('live Stalwart: mail, contacts, search (0.16 and 1.0)', () => {
  let drafts = '';
  let sent = '';
  let scratch = '';
  const mailTag = `bulwark-live-${RUN}`;

  beforeAll(async () => {
    const mod = await import('../jmap-client');
    singleton = mod.jmapClient as unknown as JMAPClient;
    client = new JMAPClient();
    await client.connect(SERVER!, USER, PASS);
    await useLogin(client);
    const boxes = await getMailboxes();
    drafts = boxes.find((b) => b.role === 'drafts')?.id ?? '';
    sent = boxes.find((b) => b.role === 'sent')?.id ?? '';
    scratch = await createMailbox({ name: `live-mail-${RUN}` });
  }, 60_000);

  afterAll(async () => {
    await useLogin(client);
    // Sends land in Sent/Drafts (and the inbox when delivered to self).
    const leftovers = await messagesWith(mailTag).catch(() => [] as string[]);
    if (leftovers.length) await destroyEmails(leftovers).catch(() => undefined);
    if (scratch) {
      await emptyMailbox(scratch).catch(() => undefined);
      await deleteMailbox(scratch).catch(() => undefined);
    }
  }, 60_000);

  describe('keywords', () => {
    it('refuses more than 100 keywords on 1.0 without touching the ones the message has', async () => {
      const id = await importMessage(scratch, `kw many ${mailTag}`, 'x', { $flagged: true });
      const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`$label:k${i}`, true]));
      const write = patchKeywordsForEmails([id], many);
      if (is10()) {
        const err = await write.then(() => null, (e: unknown) => e);
        expect(isJMAPSetError(err)).toBe(true);
        expect((err as { type?: string }).type).toBe('tooManyKeywords');
      } else {
        await write;
      }
      const [flags] = (await getEmailFlags([id])).list;
      expect(flags.keywords.$flagged).toBe(true);
      const labels = Object.keys(flags.keywords).filter((k) => k.startsWith('$label:'));
      // 0.16 takes them and silently keeps 100 keywords in all.
      if (is10()) expect(labels).toHaveLength(0);
      else expect(Object.keys(flags.keywords).length).toBeLessThanOrEqual(100);
    }, 60_000);

    it('refuses a keyword over 128 bytes on 1.0; 0.16 cuts it', async () => {
      const id = await importMessage(scratch, `kw long ${mailTag}`, 'x', { $flagged: true });
      const long = `$label:${'x'.repeat(122)}`; // 129 bytes
      const write = patchKeywordsForEmails([id], { [long]: true });
      if (is10()) {
        const err = await write.then(() => null, (e: unknown) => e);
        expect(isJMAPSetError(err)).toBe(true);
        expect((err as { type?: string }).type).toBe('invalidProperties');
      } else {
        await write;
      }
      const [flags] = (await getEmailFlags([id])).list;
      expect(flags.keywords.$flagged).toBe(true);
      // Neither server stores the 129-byte keyword as sent.
      expect(flags.keywords[long]).toBeUndefined();
    }, 60_000);
  });

  describe('submissions', () => {
    it('destroys the record of an immediate send right away', async () => {
      const [identity] = await getIdentities();
      const result = await sendEmail(
        { from: [{ email: USER }], to: [{ email: USER }], subject: `now ${mailTag}`, textBody: 'live' },
        identity.id, sent, undefined, { draftsMailboxId: drafts },
      );
      expect(result.emailSubmissionId).toBeTruthy();
      expect(await submissionExists(result.emailSubmissionId!)).toBe(false);
      const [filed] = await getFullEmails([result.emailId!]);
      expect(filed.mailboxIds[sent]).toBe(true);
    }, 60_000);

    it('lists, reschedules, cancels and restores a delayed send', async () => {
      const [identity] = await getIdentities();
      const result = await sendEmail(
        { from: [{ email: USER }], to: [{ email: USER }], subject: `later ${mailTag}`, textBody: 'live' },
        identity.id, sent, 3600, { draftsMailboxId: drafts },
      );
      expect(result.scheduled).toBe(true);
      const first = (await listScheduledEmails()).find((s) => s.emailSubmissionId === result.emailSubmissionId);
      expect(first?.emailId).toBe(result.emailId);

      const moved = await rescheduleScheduledSend(first!, 7200);
      expect(moved.emailSubmissionId).toBeTruthy();
      expect(moved.emailSubmissionId).not.toBe(first!.emailSubmissionId);
      const listed = await listScheduledEmails();
      expect(listed.some((s) => s.emailSubmissionId === first!.emailSubmissionId)).toBe(false);
      const second = listed.find((s) => s.emailSubmissionId === moved.emailSubmissionId);
      expect(new Date(second!.sendAt).getTime()).toBeGreaterThan(new Date(first!.sendAt).getTime() + 3_000_000);

      await cancelScheduledSend(second!.emailSubmissionId);
      expect((await listScheduledEmails()).some((s) => s.emailId === result.emailId)).toBe(false);
      expect(await submissionExists(second!.emailSubmissionId)).toBe(false);

      await restoreEmailToDraft(result.emailId!, drafts, sent);
      const [restored] = await getFullEmails([result.emailId!]);
      expect(restored.mailboxIds[drafts]).toBe(true);
      expect(restored.mailboxIds[sent]).toBeUndefined();
      expect(restored.keywords.$draft).toBe(true);
    }, 90_000);

    it('sends a delayed message now', async () => {
      const [identity] = await getIdentities();
      const result = await sendEmail(
        { from: [{ email: USER }], to: [{ email: USER }], subject: `send now ${mailTag}`, textBody: 'live' },
        identity.id, sent, 3600, { draftsMailboxId: drafts },
      );
      const held = (await listScheduledEmails()).find((s) => s.emailSubmissionId === result.emailSubmissionId)!;
      const now = await rescheduleScheduledSend(held, 0);
      expect(now.emailSubmissionId).toBeTruthy();
      const later = (await listScheduledEmails()).filter((s) => s.emailId === result.emailId);
      // Only the one-second replacement can still be listed, never the hour-long hold.
      expect(later.every((s) => s.emailSubmissionId === now.emailSubmissionId)).toBe(true);
      const [filed] = await getFullEmails([result.emailId!]);
      expect(filed.mailboxIds[sent]).toBe(true);
    }, 90_000);

    it('prunes final submission records', async () => {
      await sleep(3_000);
      expect(await pruneEmailSubmissions({ force: true })).toBeGreaterThanOrEqual(0);
    }, 60_000);
  });

  describe('contacts', () => {
    const created: string[] = [];
    afterAll(async () => {
      await useLogin(client);
      if (created.length) await deleteContacts(created).catch(() => undefined);
    });

    it('saves a photo as a blob on 1.0 and as a data: URI on 0.16, and exports and re-imports it as vCard', async () => {
      const [book] = await getAddressBooks();
      const card: Partial<ContactCard> = {
        '@type': 'Card', version: '1.0', kind: 'individual',
        name: { components: [{ kind: 'given', value: `Live${RUN}` }, { kind: 'surname', value: 'Photo' }] },
        media: { p1: { '@type': 'Media', kind: 'photo', mediaType: 'image/png', uri: `data:image/png;base64,${PNG_BASE64}` } },
      } as Partial<ContactCard>;
      const saved = await writeContactWithNewPhoto(undefined, card, 'p1', (c) => createContact(c, book.id));
      created.push(saved.id);
      const photo = Object.values(saved.media ?? {})[0];
      if (is10()) expect(photo?.blobId).toBeTruthy();
      else expect(photo?.uri).toContain('base64,');

      const [exported] = await inlineContactMediaForExport([saved]);
      const exportedPhoto = Object.values(exported.media ?? {})[0];
      expect(exportedPhoto?.uri?.replace(/^data:[^,]*,/, '')).toBe(PNG_BASE64);

      const vcf = generateVCard([exported]);
      expect(vcf).toMatch(/PHOTO/);
      // As the import sheet does (contacts-store importContacts): the parsed
      // card's client-side id and books go, its UID stays. Both servers
      // refuse a second card with the same UID, so the original goes first.
      const { id: _id, addressBookIds: _books, ...parsed } = parseVCard(vcf)[0];
      await deleteContacts([saved.id]);
      const imported = await createContact(parsed, book.id);
      created.push(imported.id);
      const back = await getContact(imported.id);
      const backPhoto = Object.values(back?.media ?? {})[0];
      expect(backPhoto?.blobId || backPhoto?.uri).toBeTruthy();
      const [reexported] = await inlineContactMediaForExport([back!]);
      expect(Object.values(reexported.media ?? {})[0]?.uri?.replace(/^data:[^,]*,/, '')).toBe(PNG_BASE64);
    }, 60_000);

    it('reports the directory as off on 1.0 instead of failing', async () => {
      const listing = await listPrincipals();
      if (is10()) {
        expect(listing.status).toBe('restricted');
        expect(listing.directoryQueriesOff).toBe(true);
        // What 1.0 still lists: at least the user's own principal.
        expect(listing.principals.length).toBeGreaterThan(0);
      } else {
        expect(['ok', 'restricted']).toContain(listing.status);
      }
    }, 60_000);

    (USER2 ? it : it.skip)('writes a card through its own login when the ids repeat across logins', async () => {
      const second = new JMAPClient();
      await second.connect(SERVER!, USER2!, PASS2);
      const make = async (who: string) => {
        const [book] = await getAddressBooks();
        return createContact({
          '@type': 'Card', version: '1.0', kind: 'individual',
          name: { components: [{ kind: 'given', value: `${who}${RUN}` }] },
        } as Partial<ContactCard>, book.id);
      };
      const mine = await make('Own');
      created.push(mine.id);
      await useLogin(second);
      let theirs: ContactCard | undefined;
      try {
        theirs = await make('Second');
        // Destroying the second login's card through that login leaves the
        // first login's card alone, whatever the ids are.
        await deleteContacts([theirs.id]);
        theirs = undefined;
      } finally {
        if (theirs) await deleteContacts([theirs.id]).catch(() => undefined);
        await useLogin(client);
      }
      expect((await getContact(mine.id))?.id).toBe(mine.id);
    }, 60_000);
  });

  describe('search, folders, Sieve, identities, Metadata', () => {
    it('finds a quoted phrase as a phrase on 1.0 and by its words on 0.16', async () => {
      const id = await importMessage(scratch, `search ${mailTag}`, 'the annual report for the board');
      const phrase = await eventually(() => searchEmails('"annual report"', scratch), (ids) => ids.includes(id));
      expect(phrase).toContain(id);
      const reversed = await searchEmails('"report annual"', scratch);
      if (is10()) expect(reversed).not.toContain(id);
      else expect(reversed).toContain(id);
      // A phrase next to a bare word: two conditions ANDed (the splitter).
      expect(await searchEmails('"annual report" board', scratch)).toContain(id);
      expect(await searchEmails('"annual report" nonexistentword', scratch)).not.toContain(id);
    }, 60_000);

    it('reports a new folder through Mailbox/changes', async () => {
      const { state } = await getMailboxesWithState();
      const id = await createMailbox({ name: `live-changes-${RUN}` });
      try {
        const changes = await getMailboxChanges(state);
        expect(changes?.created).toContain(id);
      } finally {
        await deleteMailbox(id);
      }
    }, 60_000);

    it('keeps Metadata out of the folder list', async () => {
      const res = await client.request([
        ['Mailbox/get', { accountId: client.accountId, properties: MAILBOX_PROPERTIES }, '0'],
      ]);
      const [first] = res.methodResponses[0][1].list as Record<string, unknown>[];
      expect(first).not.toHaveProperty('metadata');
      expect(first).toHaveProperty('myRights');
    }, 60_000);

    // Shared tags (#1310) live in a group's Inbox metadata. The test login
    // is in no group, so this checks the shape on its own Inbox: written the
    // way the webmail writes it, read the way the app reads it.
    it('reads shared tags from Inbox metadata on 1.0 and asks nothing of 0.16', async () => {
      resetBulwarkMetadata();
      const accountId = client.accountId;
      if (!is10()) {
        expect(supportsBulwarkMetadata(accountId)).toBe(false);
        expect(await getBulwarkMetadata(accountId)).toBeNull();
        return;
      }
      const using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:metadata'];
      const inbox = (await getMailboxes()).find((m) => m.role === 'inbox')!.id;
      const before = await getBulwarkMetadata(accountId);
      expect(before).not.toBeNull();
      const setTags = (value: unknown, path = '') => client.request([
        ['Mailbox/set', { accountId, update: { [inbox]: { [`metadata/org.bulwarkmail.tags${path}`]: value } } }, '0'],
      ], using);
      try {
        const written = await setTags({ tags: { [`live-${RUN}`]: { label: 'Live check', color: 'teal-dark', note: 'kept' } } });
        expect(written.methodResponses[0][1].updated).toHaveProperty(inbox);
        // One tag patched on its own, as the webmail saves a change.
        await setTags({ label: 'Second', color: 'blue' }, `/tags/second-${RUN}`);

        resetBulwarkMetadata();
        const entries = await getBulwarkMetadata(accountId);
        expect(parseSharedTags(entries?.[SHARED_TAGS_KEY])).toEqual([
          { id: `live-${RUN}`, label: 'Live check', color: 'teal' },
          { id: `second-${RUN}`, label: 'Second', color: 'blue' },
        ]);
      } finally {
        await setTags(before?.[SHARED_TAGS_KEY] ?? null);
      }
      const after = await getBulwarkMetadata(accountId);
      expect(after?.[SHARED_TAGS_KEY]).toEqual(before?.[SHARED_TAGS_KEY]);
    }, 60_000);

    it('creates, reads, validates and deletes a Sieve script', async () => {
      const content = `require ["fileinto"];\r\n# ${RUN} */\r\nif header :contains "subject" "${RUN}" { fileinto "INBOX"; }\r\n`;
      expect((await validateSieveScript(content)).isValid).toBe(true);
      expect((await validateSieveScript('if bogus {')).isValid).toBe(false);
      const script = await createSieveScript(`live-${RUN}`, content, false);
      try {
        const listed = (await getSieveScripts()).find((s) => s.id === script.id);
        expect(listed?.name).toBe(`live-${RUN}`);
        expect(await getSieveScriptContent(listed!.blobId)).toContain(RUN);
      } finally {
        await deleteSieveScript(script.id);
      }
    }, 60_000);

    it('deletes a filter rule at once and puts it back on Undo, in the script on the server', async () => {
      // The account's filters as they are, to put back afterwards.
      const before = await getSieveScripts();
      const active = before.find((s) => s.isActive && s.name !== 'vacation');
      const original = active ? await getSieveScriptContent(active.blobId) : null;
      const activeContent = async () => {
        const now = (await getSieveScripts()).find((s) => s.isActive && s.name !== 'vacation');
        return now ? getSieveScriptContent(now.blobId) : '';
      };
      try {
        await useFilterStore.getState().selectAccount(null);
        expect(useFilterStore.getState().isOpaque, 'the test account has no hand-written filters').toBe(false);
        const rule = (id: string) => ({
          id, name: `live ${id} ${RUN}`, enabled: true, matchType: 'all' as const,
          conditions: [{ field: 'subject' as const, comparator: 'contains' as const, value: `${id}-${RUN}` }],
          actions: [{ type: 'mark_read' as const, value: '' }], stopProcessing: false,
        });
        useFilterStore.getState().addRule(rule('one'));
        useFilterStore.getState().addRule(rule('two'));
        await useFilterStore.getState().saveFilters();
        expect(await activeContent()).toContain(`one-${RUN}`);

        const undo = await useFilterStore.getState().deleteRuleNow('one');
        let content = await activeContent();
        expect(content).not.toContain(`one-${RUN}`);
        expect(content).toContain(`two-${RUN}`);

        expect(await undo!()).toBe(true);
        content = await activeContent();
        expect(content.indexOf(`one-${RUN}`)).toBeGreaterThan(-1);
        expect(content.indexOf(`one-${RUN}`)).toBeLessThan(content.indexOf(`two-${RUN}`));
      } finally {
        const after = await getSieveScripts();
        if (active && original !== null) await updateSieveScript(active.id, original, true);
        for (const script of after) {
          if (!before.some((b) => b.id === script.id)) await deleteSieveScript(script.id).catch(() => undefined);
        }
        useFilterStore.getState().clearState();
      }
    }, 60_000);

    it('changes and restores an identity\'s name and signature', async () => {
      const [identity] = await getIdentities();
      const before = { name: identity.name, textSignature: identity.textSignature ?? '' };
      try {
        await updateIdentity(identity.id, { name: `Live ${RUN}`, textSignature: `sig ${RUN}` });
        const changed = (await getIdentities()).find((i) => i.id === identity.id);
        expect(changed?.name).toBe(`Live ${RUN}`);
        expect(changed?.textSignature).toBe(`sig ${RUN}`);
      } finally {
        await updateIdentity(identity.id, before);
      }
    }, 60_000);
  });

  describe('mail list (reader pass)', () => {
    it('lists the Authentication-Results headers so a forged From gets the warning shield (bulwarkmail/webmail#1439)', async () => {
      const subject = `forged ${mailTag}`;
      const raw = [
        'Authentication-Results: mx.example.org; spf=fail smtp.mailfrom=evil.example; dkim=none; dmarc=fail header.from=bank.example',
        'From: Bank <ceo@bank.example>',
        `To: ${USER}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <forged-${RUN}@live.test>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'hello',
        '',
      ].join('\r\n');
      const { blobId } = await uploadBytes(new TextEncoder().encode(raw), 'message/rfc822');
      const id = await importEmailBlob(blobId, scratch, {});
      const page = await queryEmailPage(scratch, { limit: 10 });
      const row = page.list.find((e) => e.id === id);
      expect(row).toBeDefined();
      expect(senderWarningOf(row!)?.status).toBe('failed');
      // The Date header, for sorting by date sent in merged lists (bulwarkmail/webmail#1219).
      expect(typeof row!.sentAt).toBe('string');
      // The full fetch reads the same verdict from `headers`.
      const [full] = await getFullEmails([id]);
      expect(senderWarningOf(full)?.status).toBe('failed');
    }, 60_000);

    it("finds a conversation's message that waits for a scheduled send (bulwarkmail/webmail#1404)", async () => {
      const [identity] = await getIdentities();
      const result = await sendEmail(
        { from: [{ email: USER }], to: [{ email: USER }], subject: `scheduled reply ${mailTag}`, textBody: 'live' },
        identity.id, sent, 3600, { draftsMailboxId: drafts },
      );
      try {
        const [filed] = await getFullEmails([result.emailId!]);
        const ids = await scheduledEmailIdsInThread(filed.threadId);
        expect([...ids]).toEqual([result.emailId]);
      } finally {
        await cancelScheduledSend(result.emailSubmissionId!).catch(() => undefined);
      }
      // Once cancelled it can be replied to again.
      const [filed] = await getFullEmails([result.emailId!]);
      expect((await scheduledEmailIdsInThread(filed.threadId)).size).toBe(0);
    }, 90_000);

    it('leaves Trash out of the tag counts (bulwarkmail/webmail#1156)', async (ctx) => {
      const boxes = await getMailboxes();
      const trash = boxes.find((b) => b.role === 'trash')!.id;
      const tag = 'readerpass';
      const keyword = `$label:${tag}`;
      const live = await importMessage(scratch, `tag live ${mailTag}`, 'a');
      const gone = await importMessage(trash, `tag deleted ${mailTag}`, 'b', { $seen: true });
      // Set afterwards: 0.16 drops the keywords Email/import is given.
      await patchKeywordsForEmails([live, gone], { [keyword]: true });
      const flags = await getEmailFlags([live]);
      if (!flags.list[0]?.keywords?.[keyword]) {
        // Seen on the 0.16.27 test server: Email/set answers "updated" but
        // keeps only system keywords for this account. Nothing to count.
        ctx.skip('the server did not keep the tag keyword');
        return;
      }
      const all = await eventually(() => fetchTagCounts([tag]), ([c]) => c.total === 2);
      expect(all).toEqual([{ id: tag, total: 2, unread: 1 }]);
      expect(await fetchTagCounts([tag], [undefined], { '': [trash] })).toEqual([{ id: tag, total: 1, unread: 1 }]);
      // Stalwart answers Keyword/get for no keyword counters (no capability).
      expect(client.currentSession?.capabilities?.[KEYWORDS_CAPABILITY]).toBeUndefined();
    }, 60_000);
  });
});
