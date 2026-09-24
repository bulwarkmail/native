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
 * Verified against stalwartlabs/stalwart:v0.16.19.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { JMAPClient } from '../jmap-client';
import {
  getMailboxes,
  queryEmails,
  queryEmailPage,
  getFullEmails,
  getThreadsHeaders,
  createDraft,
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
import { getCalendars, queryEvents, createEvent, deleteEvents } from '../calendar';
import { getAddressBooks, createContact, deleteContacts } from '../contacts';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const live = SERVER && PASS ? describe : describe.skip;

// The api modules talk to the exported singleton; swap its guts for a client
// connected to the live server.
let client: JMAPClient;

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

  beforeAll(async () => {
    await connectSingleton();
    const boxes = await getMailboxes();
    const byRole = (r: string) => boxes.find((b) => b.role === r)?.id ?? '';
    inbox = byRole('inbox');
    drafts = byRole('drafts');
    sent = byRole('sent');
    junk = byRole('junk');
    expect(inbox).toBeTruthy();
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

      const { ids } = await queryEmails(inbox, { limit: 20 });
      const emails = await getFullEmails(ids);
      const reply = emails.find((e) => (e.subject ?? '').startsWith('Re: '));
      expect(reply, 'seeded reply message missing').toBeTruthy();
      // Bare msg-ids, no angle brackets (RFC 8621 §4.1.2.3).
      expect(reply!.messageId?.[0]).toMatch(/^[^<>]+@[^<>]+$/);
      expect(reply!.references?.length).toBeGreaterThan(0);
      expect(Array.isArray(reply!.headers)).toBe(true);
    }, 60_000);

    it('exposes an HTML-only body as the same part in textBody and htmlBody', async () => {
      const { ids } = await queryEmails(inbox, { limit: 20 });
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
      const { ids } = await queryEmails(inbox, { limit: 20 });
      const emails = await getFullEmails(ids);
      const reply = emails.find((e) => (e.subject ?? '').startsWith('Re: '))!;
      const { threads } = await getThreadsHeaders([reply.threadId]);
      const thread = threads[reply.threadId].list;
      expect(thread.length).toBeGreaterThanOrEqual(2);
      const times = thread.map((e) => new Date(e.receivedAt).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }, 60_000);

    it('loads a list page with its threads in one chained request (PF7)', async () => {
      const page = await queryEmailPage(inbox, { limit: 20, threads: true });
      const { ids, total } = await queryEmails(inbox, { limit: 20 });
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
      const { ids } = await queryEmails(inbox, { limit: 5 });
      const target = ids[0];
      await markAsSpam([target], junk, undefined, { markRead: true });
      let [msg] = await getFullEmails([target]);
      expect(msg.mailboxIds[junk]).toBe(true);
      expect(msg.keywords.$junk).toBe(true);
      expect(msg.keywords.$seen).toBe(true);

      await undoSpam([target], inbox);
      [msg] = await getFullEmails([target]);
      expect(msg.mailboxIds[inbox]).toBe(true);
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
      const ids = await queryEvents(cals.map((c) => c.originalId ?? c.id), from, to);
      expect(Array.isArray(ids)).toBe(true);
      expect(ids.length).toBeGreaterThan(0);
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
