/**
 * Live integration test against a real Stalwart server.
 *
 * Opt-in: skipped unless `BULWARK_LIVE_JMAP` names a reachable JMAP host, so
 * the normal suite stays hermetic. It exercises the client code paths that
 * cannot be proven with mocks - the ones where a fixture only ever encodes
 * what we already believed the server does:
 *
 *   BULWARK_LIVE_JMAP=http://127.0.0.1:18081 \
 *   BULWARK_LIVE_USER=usera@example.org \
 *   BULWARK_LIVE_PASS=… npx vitest run src/api/__tests__/live-stalwart.test.ts
 *
 * The mail it reads is imported into a scratch folder first and removed
 * afterwards, so any account will do.
 *
 * Verified against stalwartlabs/stalwart:v0.16.27 and v1.0.0.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { JMAPClient } from '../jmap-client';
import {
  getMailboxes,
  queryEmails,
  queryEmailPage,
  getFullEmails,
  getThreadsHeaders,
  createDraft,
  saveDraftVersion,
  destroyEmails,
  sendEmail,
  markAsSpam,
  undoSpam,
  emptyMailbox,
  markMailboxAsRead,
  createMailbox,
  deleteMailbox,
  patchKeywordsForEmails,
  EMAIL_FULL_PROPERTIES,
} from '../email';
import { getIdentities } from '../identity';
import { uploadBytes } from '../blob';
import { initialDraftPartBlobState, liveBlobId, rebaseDraftPartBlobs } from '../../lib/draft-part-blobs';
import type { OutgoingAttachment } from '../email';
import { getCalendars, queryEvents, createEvent, deleteEvents } from '../calendar';
import { getAddressBooks, createContact, deleteContacts } from '../contacts';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const live = SERVER && PASS ? describe : describe.skip;

// The api modules talk to the exported singleton; swap its guts for a client
// connected to the live server.
let client: JMAPClient;

// A thread (root + reply), a plain-text and an HTML-only message, unique per
// run so a leftover from an aborted run neither threads with nor shadows them.
function fixtureMessages(run: string, user: string): string[] {
  const date = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toUTCString();
  const head = (subject: string, id: string, hoursAgo: number, extra = '') =>
    `From: Partner <partner@example.net>\r\nTo: ${user}\r\nSubject: ${subject}\r\n` +
    `Date: ${date(hoursAgo)}\r\nMessage-ID: <${id}-${run}@live.test>\r\nMIME-Version: 1.0\r\n${extra}`;
  return [
    head('Quarterly numbers', 'q1', 3) + 'Content-Type: text/plain; charset=utf-8\r\n\r\nThe numbers are in.\r\n',
    head('Re: Quarterly numbers', 'q2', 2, `In-Reply-To: <q1-${run}@live.test>\r\nReferences: <q1-${run}@live.test>\r\n`) +
      'Content-Type: text/plain; charset=utf-8\r\n\r\nThanks, looks good.\r\n',
    head('August digest', 'd1', 1) + 'Content-Type: text/html; charset=utf-8\r\n\r\n<html><body><p>News of the month</p></body></html>\r\n',
  ];
}

async function importFixtures(mailboxId: string): Promise<void> {
  const run = Date.now().toString(36);
  const emails: Record<string, unknown> = {};
  const messages = fixtureMessages(run, USER);
  for (const [i, raw] of messages.entries()) {
    const { blobId } = await uploadBytes(new TextEncoder().encode(raw), 'message/rfc822');
    const receivedAt = new Date(Date.now() - (3 - i) * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    emails[`m${i}`] = { blobId, mailboxIds: { [mailboxId]: true }, keywords: {}, receivedAt };
  }
  const response = await client.request([['Email/import', { accountId: client.accountId, emails }, '0']]);
  const [, result] = response.methodResponses[0] as [string, { created?: Record<string, unknown>; notCreated?: unknown }, string];
  expect(Object.keys(result.created ?? {}), JSON.stringify(result.notCreated)).toHaveLength(messages.length);
}

async function connectSingleton(): Promise<void> {
  const mod = await import('../jmap-client');
  client = new JMAPClient();
  await client.connect(SERVER!, USER, PASS);
  // The singleton is a const binding; copy the connected state onto it.
  (mod.jmapClient as unknown as JMAPClient).restoreSnapshot(client.snapshot());
}

live('live Stalwart', () => {
  let inbox = '';
  let drafts = '';
  let sent = '';
  let junk = '';
  // The scratch folder the fixtures live in; the mail tests read it.
  let fixtures = '';

  beforeAll(async () => {
    await connectSingleton();
    const boxes = await getMailboxes();
    const byRole = (r: string) => boxes.find((b) => b.role === r)?.id ?? '';
    inbox = byRole('inbox');
    drafts = byRole('drafts');
    sent = byRole('sent');
    junk = byRole('junk');
    expect(inbox).toBeTruthy();
    fixtures = await createMailbox({ name: `live-fixtures-${Date.now()}` });
    await importFixtures(fixtures);
  }, 60_000);

  afterAll(async () => {
    if (!fixtures) return;
    await emptyMailbox(fixtures).catch(() => undefined);
    await deleteMailbox(fixtures).catch(() => undefined);
  }, 60_000);

  describe('session', () => {
    it('rebases the advertised session URLs onto the connected origin', () => {
      // Stalwart advertises its configured hostname (https://stwtest.local/…),
      // which is unreachable from a client that connected by IP/port. Without
      // the rewrite every request after login fails.
      const session = client.currentSession!;
      expect(session.apiUrl.startsWith(SERVER!)).toBe(true);
      expect(session.downloadUrl.startsWith(SERVER!)).toBe(true);
      // …and the RFC 6570 templates must survive the rewrite.
      expect(session.downloadUrl).toContain('{accountId}');
      expect(session.downloadUrl).toContain('{blobId}');
      expect(session.eventSourceUrl).toContain('{types}');
    });

    it('finds the Stalwart extension in accountCapabilities, not session capabilities (native #47)', () => {
      const session = client.currentSession!;
      expect('urn:stalwart:jmap' in (session.capabilities ?? {})).toBe(false);
      expect(client.hasAccountCapability('urn:stalwart:jmap')).toBe(true);
      // The pre-fix session-level check is what made Account Security dead.
      expect(client.hasCapability('urn:stalwart:jmap')).toBe(false);
    });

    it('finds scheduled send in the account submission capability (#57)', () => {
      const session = client.currentSession!;
      const sessionLevel = session.capabilities?.['urn:ietf:params:jmap:submission'] as Record<string, unknown> | undefined;
      expect(sessionLevel?.maxDelayedSend).toBeUndefined();
      expect(client.hasDelayedSend()).toBe(true);
      expect(client.getMaxDelayedSend()).toBeGreaterThan(0);
      expect(client.getMaxSizeAttachmentsPerEmail()).toBeGreaterThan(0);
    });

    it('reads the advertised request limits', () => {
      expect(client.getMaxObjectsInGet()).toBeGreaterThan(0);
      expect(client.getMaxObjectsInSet()).toBeGreaterThan(0);
      expect(client.getMaxSizeUpload()).toBeGreaterThan(0);
    });

    it('rejects bad credentials with AuthenticationError', async () => {
      const bad = new JMAPClient();
      await expect(bad.connect(SERVER!, USER, 'definitely-not-the-password'))
        .rejects.toMatchObject({ name: 'AuthenticationError' });
    }, 30_000);
  });

  describe('mail', () => {
    it('fetches the threading headers the composer needs (#234)', async () => {
      expect(EMAIL_FULL_PROPERTIES).toContain('messageId');
      expect(EMAIL_FULL_PROPERTIES).toContain('references');
      expect(EMAIL_FULL_PROPERTIES).toContain('headers');

      const { ids } = await queryEmails(fixtures, { limit: 20 });
      const emails = await getFullEmails(ids);
      const reply = emails.find((e) => (e.subject ?? '').startsWith('Re: '));
      expect(reply, 'seeded reply message missing').toBeTruthy();
      // Bare msg-ids, no angle brackets (RFC 8621 §4.1.2.3).
      expect(reply!.messageId?.[0]).toMatch(/^[^<>]+@[^<>]+$/);
      expect(reply!.references?.length).toBeGreaterThan(0);
      expect(Array.isArray(reply!.headers)).toBe(true);
    }, 60_000);

    it('exposes an HTML-only body as the same part in textBody and htmlBody', async () => {
      const { ids } = await queryEmails(fixtures, { limit: 20 });
      const emails = await getFullEmails(ids);
      const news = emails.find((e) => (e.subject ?? '').includes('August digest'));
      expect(news, 'seeded HTML-only message missing').toBeTruthy();
      const textPart = news!.textBody?.[0];
      const htmlPart = news!.htmlBody?.[0];
      // The native #46 shape: identical partId, and the part is text/html.
      expect(textPart?.partId).toBe(htmlPart?.partId);
      expect(htmlPart?.type).toBe('text/html');

      // A plain-text message reports the same partId too - only `type` tells
      // them apart, which is why the picker must route by type.
      const plain = emails.find((e) => (e.subject ?? '') === 'Quarterly numbers');
      expect(plain!.textBody?.[0]?.partId).toBe(plain!.htmlBody?.[0]?.partId);
      expect(plain!.htmlBody?.[0]?.type).toBe('text/plain');
    }, 60_000);

    it('returns every message of a thread, oldest first', async () => {
      const { ids } = await queryEmails(fixtures, { limit: 20 });
      const emails = await getFullEmails(ids);
      const reply = emails.find((e) => (e.subject ?? '').startsWith('Re: '))!;
      const { threads } = await getThreadsHeaders([reply.threadId]);
      const thread = threads[reply.threadId].list;
      expect(thread.length).toBeGreaterThanOrEqual(2);
      const times = thread.map((e) => new Date(e.receivedAt).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }, 60_000);

    it('loads a list page with its threads in one chained request (PF7)', async () => {
      const page = await queryEmailPage(fixtures, { limit: 20, threads: true });
      const { ids, total } = await queryEmails(fixtures, { limit: 20 });
      expect(page.ids).toEqual(ids);
      expect(page.total).toBe(total);
      expect(page.list.map((e) => e.id)).toEqual(ids);
      expect(page.state).toBeTruthy();
      const threadIds = new Set(page.list.map((e) => e.threadId));
      expect(new Set(page.threads.map((t) => t.id))).toEqual(threadIds);
      const reply = page.list.find((e) => (e.subject ?? '').startsWith('Re: '))!;
      expect(page.threads.find((t) => t.id === reply.threadId)!.emailIds.length).toBeGreaterThanOrEqual(2);
    }, 60_000);

    it('saves a draft into Drafts with $draft', async () => {
      const id = await createDraft(
        {
          from: [{ email: USER }],
          to: [{ email: 'userb@example.org' }],
          subject: 'Draft from the live test',
          textBody: 'draft body',
        },
        drafts,
      );
      const [saved] = await getFullEmails([id]);
      expect(saved.mailboxIds[drafts]).toBe(true);
      expect(saved.keywords.$draft).toBe(true);
      // Message-ID is generated client-side from the sender's domain.
      expect(saved.messageId?.[0]).toContain('@example.org');
      await patchKeywordsForEmails([id], { $seen: true });
      const { destroyEmails } = await import('../email');
      await destroyEmails([id]);
    }, 60_000);

    it('keeps a re-opened draft with an inline image saveable across saves (#849 part blobs)', async () => {
      // A 1x1 PNG uploaded once; D0 stands for the draft as it sits on the server.
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      const up = await uploadBytes(png, 'image/png');
      const base = {
        from: [{ email: USER }],
        to: [{ email: 'test@example.invalid' }],
        subject: '[TEST bulwark-blob — supprimable]',
        htmlBody: '<p>live <img src="cid:img1@live.test"></p>',
        textBody: 'live',
      };
      const img = (blobId: string): OutgoingAttachment => ({
        blobId, type: 'image/png', name: 'img1.png', size: png.byteLength, disposition: 'inline', cid: 'img1@live.test',
      });
      const d0 = await saveDraftVersion({ ...base, attachments: [img(up.blobId)] }, drafts);
      const created = [d0.id];
      try {
        // Re-open D0: the composer holds D0's part blobId.
        const seeded = d0.attachments[0].blobId;
        let state = initialDraftPartBlobState();
        let draftId = d0.id;
        for (let i = 0; i < 2; i++) {
          const sent = [img(liveBlobId(state, seeded))];
          const saved = await saveDraftVersion({ ...base, attachments: sent }, drafts, draftId);
          created.push(saved.id);
          draftId = saved.id;
          state = rebaseDraftPartBlobs(state, sent, saved.attachments);
        }
        // Without the rebase the seeded part blob is gone with D0.
        await expect(saveDraftVersion({ ...base, attachments: [img(seeded)] }, drafts))
          .rejects.toThrow(/does not exist|blobNotFound/);
        const [last] = await getFullEmails([draftId]);
        expect(last.attachments?.[0]?.cid).toContain('img1@live.test');
      } finally {
        await destroyEmails(created).catch(() => undefined);
      }
    }, 90_000);

    it('sends through Drafts and files into Sent only after submission (#188)', async () => {
      const identities = await getIdentities();
      expect(identities.length).toBeGreaterThan(0);
      const result = await sendEmail(
        {
          from: [{ email: USER }],
          to: [{ email: 'userb@example.org' }],
          subject: 'Live send test',
          textBody: 'sent by the live integration test',
          inReplyTo: ['<root-1@partner.example>'],
          references: ['<root-1@partner.example>'],
        },
        identities[0].id,
        sent,
        undefined,
        { draftsMailboxId: drafts },
      );
      expect(result.emailId).toBeTruthy();
      expect(result.emailSubmissionId).toBeTruthy();
      expect(result.filingWarning).toBeUndefined();

      const [filed] = await getFullEmails([result.emailId!]);
      // onSuccessUpdateEmail moved it out of Drafts into Sent.
      expect(filed.mailboxIds[sent]).toBe(true);
      expect(filed.mailboxIds[drafts]).toBeUndefined();
      expect(filed.keywords.$draft).toBeUndefined();
      // Threading headers went out as bare msg-ids, not the JMAP id.
      expect(filed.inReplyTo).toEqual(['root-1@partner.example']);
      expect(filed.references).toEqual(['root-1@partner.example']);
    }, 90_000);

    it('flips $junk/$notjunk when filing spam and undoing it (#850)', async () => {
      const { ids } = await queryEmails(fixtures, { limit: 5 });
      const target = ids[0];
      await markAsSpam([target], junk, undefined, { markRead: true });
      let [msg] = await getFullEmails([target]);
      expect(msg.mailboxIds[junk]).toBe(true);
      expect(msg.keywords.$junk).toBe(true);
      expect(msg.keywords.$seen).toBe(true);

      await undoSpam([target], fixtures);
      [msg] = await getFullEmails([target]);
      expect(msg.mailboxIds[fixtures]).toBe(true);
      expect(msg.mailboxIds[junk]).toBeUndefined();
      expect(msg.keywords.$junk).toBeUndefined();
      expect(msg.keywords.$notjunk).toBe(true);
    }, 90_000);

    it('empties a folder and marks one read in batches', async () => {
      const scratch = await createMailbox({ name: `live-test-${Date.now()}` });
      try {
        // Nothing in it yet: the loop must terminate on an empty page.
        expect(await emptyMailbox(scratch)).toBe(0);
        expect(await markMailboxAsRead(scratch)).toBe(0);
      } finally {
        await deleteMailbox(scratch);
      }
    }, 60_000);
  });

  describe('calendar', () => {
    it('queries a date window with the singular inCalendar filter', async () => {
      const cals = await getCalendars();
      expect(cals.length).toBeGreaterThan(0);
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      const to = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString();
      // An event of our own inside the window, so an empty calendar passes too.
      const cal = cals[0];
      const created = await createEvent(
        { title: 'Live window event', start: now.toISOString().replace(/\.\d+Z$/, ''), duration: 'PT30M', timeZone: 'Europe/Berlin' },
        cal.originalId ?? cal.id,
      );
      try {
        const ids = await queryEvents(cals.map((c) => c.originalId ?? c.id), from, to);
        expect(ids).toContain(created.id);
      } finally {
        await deleteEvents([created.id]);
      }
    }, 60_000);

    it('creates a timed event with a time zone and destroys it', async () => {
      const cals = await getCalendars();
      const cal = cals[0];
      const start = new Date(Date.now() + 86_400_000);
      const created = await createEvent(
        {
          title: 'Live test event',
          start: start.toISOString().replace(/\.\d+Z$/, '').replace('T', 'T'),
          duration: 'PT1H',
          timeZone: 'Europe/Berlin',
        },
        cal.originalId ?? cal.id,
      );
      expect(created.id).toBeTruthy();
      await deleteEvents([created.id]);
    }, 60_000);
  });

  describe('contacts', () => {
    it('creates a card with a UID and an RFC 9553 PartialDate birthday (#644, #224)', async () => {
      const books = await getAddressBooks();
      expect(books.length).toBeGreaterThan(0);
      const book = books[0];
      const created = await createContact(
        {
          name: { components: [{ kind: 'given', value: 'Live' }, { kind: 'surname', value: 'Test' }] },
          emails: { e1: { address: `live-${Date.now()}@example.org` } },
          anniversaries: {
            a1: {
              '@type': 'Anniversary',
              kind: 'birth',
              // A raw "1985-04-12" string is rejected by Stalwart (#224).
              date: { '@type': 'PartialDate', year: 1985, month: 4, day: 12 },
            },
          },
        },
        book.originalId ?? book.id,
      );
      try {
        expect(created.id).toBeTruthy();
        // createContact re-reads the card, so the caller gets a full object.
        expect(created.uid).toBeTruthy();
        expect(created.name?.components?.length).toBeGreaterThan(0);
      } finally {
        await deleteContacts([created.id]);
      }
    }, 60_000);
  });
});
