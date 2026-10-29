/**
 * Live checks of the composer's sending paths against a real Stalwart, for
 * the differences between 0.16 and 1.0: reschedule and "Send now" cancel
 * the original first (#1308), Cancel send puts the message back in Drafts
 * (native #84), Files and mail share blobs (#1179, Save to Files), Blob/copy
 * needs the blob capability, and templates live in the Inbox metadata on
 * 1.0.0 only.
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP` and
 * `BULWARK_LIVE_PASS` are set.
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-phone-dark@example.org BULWARK_LIVE_PASS=… \
 *   npx vitest run src/api/__tests__/live-stalwart-compose.test.ts
 *
 * Everything it creates is removed again. Mail goes to the user's own
 * address and nothing depends on delivery (SMTP is down on the test VM).
 *
 * Verified against stalwartlabs/stalwart:v0.16.27 and v1.0.0 (2026-10-29).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

import { JMAPClient } from '../jmap-client';
import {
  cancelScheduledSend, destroyEmails, getFullEmails, getMailboxes, listScheduledEmails, rescheduleScheduledSend, saveDraftVersion, sendEmail,
} from '../email';
import { uploadBytes } from '../blob';
import { deleteFileNodes } from '../files';
import { getIdentities, resolveSendAccountId } from '../identity';
import {
  getBulwarkMetadata, MetadataTooLargeError, resetBulwarkMetadata, setBulwarkMetadata, supportsBulwarkMetadata,
} from '../bulwark-metadata';
import { CAPABILITIES } from '../types';
import { cancelScheduledToDrafts } from '../../lib/compose-scheduled';
import { attachmentFromFileNode, saveAttachmentToFiles } from '../../lib/compose-files';
import { servedLoginOf } from '../../lib/draft-login';
import { useAccountStore } from '../../stores/account-store';
import { useTemplatesStore } from '../../stores/templates-store';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'e2e-phone-dark@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const live = SERVER && PASS ? describe : describe.skip;

const RUN = Date.now().toString(36);

let client: JMAPClient;
let singleton: JMAPClient;

/** Stalwart 1.0 advertises JMAP Metadata, 0.16 does not. */
const is10 = () => !!client.currentSession?.capabilities?.['urn:ietf:params:jmap:metadata'];

live('live Stalwart: composer and sending (0.16 and 1.0)', () => {
  let drafts = '';
  let sent = '';
  const tag = `bulwark-compose-${RUN}`;
  const createdEmails: string[] = [];
  const createdNodes: string[] = [];

  beforeAll(async () => {
    const mod = await import('../jmap-client');
    singleton = mod.jmapClient as unknown as JMAPClient;
    client = new JMAPClient();
    await client.connect(SERVER!, USER, PASS);
    singleton.restoreSnapshot(client.snapshot());
    const boxes = await getMailboxes();
    drafts = boxes.find((b) => b.role === 'drafts')?.id ?? '';
    sent = boxes.find((b) => b.role === 'sent')?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    // A failed test may leave a send scheduled; it must not outlive its message.
    const held = await listScheduledEmails().catch(() => []);
    for (const s of held.filter((h) => createdEmails.includes(h.emailId))) {
      await cancelScheduledSend(s.emailSubmissionId).catch(() => undefined);
    }
    const res = await singleton.request([['Email/query', { accountId: singleton.accountId, filter: { subject: tag } }, '0']]);
    const leftovers = [...new Set([...(res.methodResponses[0][1].ids as string[] ?? []), ...createdEmails])];
    if (leftovers.length) await destroyEmails(leftovers).catch(() => undefined);
    if (createdNodes.length) await deleteFileNodes(createdNodes).catch(() => undefined);
  }, 60_000);

  describe('scheduled sends', () => {
    it('cancels the original before it schedules the replacement, then sends a cancelled one back to Drafts', async () => {
      const [identity] = await getIdentities();
      const result = await sendEmail(
        { from: [{ email: USER }], to: [{ email: USER }], subject: `later ${tag}`, textBody: 'live' },
        identity.id, sent, 3600, { draftsMailboxId: drafts },
      );
      createdEmails.push(result.emailId!);
      const first = (await listScheduledEmails()).find((s) => s.emailSubmissionId === result.emailSubmissionId)!;
      expect(first).toBeTruthy();

      const request = vi.spyOn(singleton, 'request');
      const moved = await rescheduleScheduledSend(first, 7200);
      // The cancel of the original goes out before the replacement's create.
      const sets = request.mock.calls
        .map(([calls]) => calls[0])
        .filter(([name]) => name === 'EmailSubmission/set')
        .map(([, args]) => (args.update ? 'cancel' : args.create ? 'create' : 'destroy'));
      expect(sets.slice(0, 3)).toEqual(['cancel', 'destroy', 'create']);
      request.mockRestore();
      expect(moved.emailSubmissionId).toBeTruthy();
      const listed = await listScheduledEmails();
      expect(listed.some((s) => s.emailSubmissionId === first.emailSubmissionId)).toBe(false);
      const second = listed.find((s) => s.emailSubmissionId === moved.emailSubmissionId)!;
      expect(new Date(second.sendAt).getTime()).toBeGreaterThan(new Date(first.sendAt).getTime() + 3_000_000);
      // The replacement filed it in Sent.
      const [filed] = await getFullEmails([result.emailId!]);
      expect(filed.mailboxIds[sent]).toBe(true);

      // Cancel send: nothing goes out, and the message is a draft again.
      const cancelled = await cancelScheduledToDrafts(second, await getMailboxes(), singleton.accountId);
      expect(cancelled).toEqual({ inDrafts: true });
      expect((await listScheduledEmails()).some((s) => s.emailId === result.emailId)).toBe(false);
      const [restored] = await getFullEmails([result.emailId!]);
      expect(restored.mailboxIds[drafts]).toBe(true);
      expect(restored.mailboxIds[sent]).toBeUndefined();
      expect(restored.keywords.$draft).toBe(true);
    }, 90_000);
  });

  describe('scheduled sends whose answers get lost', () => {
    /** Let the first call matching `pick` reach the server, then lose its answer. */
    const loseAnswerOf = (pick: (method: string, args: Record<string, unknown>) => boolean) => {
      const real = singleton.request.bind(singleton);
      let lost = false;
      return vi.spyOn(singleton, 'request').mockImplementation(async (calls, using) => {
        const res = await real(calls, using);
        const [method, args] = calls[0] as unknown as [string, Record<string, unknown>];
        if (!lost && pick(method, args)) {
          lost = true;
          throw new Error('Request timed out');
        }
        return res;
      });
    };
    const scheduleOne = async (label: string) => {
      const [identity] = await getIdentities();
      const result = await sendEmail(
        { from: [{ email: USER }], to: [{ email: USER }], subject: `${label} ${tag}`, textBody: 'live' },
        identity.id, sent, 3600, { draftsMailboxId: drafts },
      );
      createdEmails.push(result.emailId!);
      return (await listScheduledEmails()).find((s) => s.emailSubmissionId === result.emailSubmissionId)!;
    };
    const pendingOf = async (emailId: string) => (await listScheduledEmails()).filter((s) => s.emailId === emailId);

    it('makes the replacement when the cancel went through and its answer was lost', async () => {
      const first = await scheduleOne('lost cancel');
      const spy = loseAnswerOf((method, args) => method === 'EmailSubmission/set' && !!args.update);
      let moved: Awaited<ReturnType<typeof rescheduleScheduledSend>>;
      try {
        moved = await rescheduleScheduledSend(first, 7200);
      } finally {
        spy.mockRestore();
      }
      const pending = await pendingOf(first.emailId);
      expect(pending.map((s) => s.emailSubmissionId)).toEqual([moved.emailSubmissionId]);
      await cancelScheduledToDrafts(pending[0], await getMailboxes(), singleton.accountId);
    }, 90_000);

    it('takes the replacement the server made when the answer to its create was lost, and schedules it once', async () => {
      const first = await scheduleOne('lost create');
      const spy = loseAnswerOf((method, args) => method === 'EmailSubmission/set' && !!args.create);
      let moved: Awaited<ReturnType<typeof rescheduleScheduledSend>>;
      try {
        moved = await rescheduleScheduledSend(first, 7200);
      } finally {
        spy.mockRestore();
      }
      const pending = await pendingOf(first.emailId);
      expect(pending.map((s) => s.emailSubmissionId)).toEqual([moved.emailSubmissionId]);
      expect(new Date(pending[0].sendAt).getTime()).toBeGreaterThan(new Date(first.sendAt).getTime() + 3_000_000);
      await cancelScheduledToDrafts(pending[0], await getMailboxes(), singleton.accountId);
    }, 90_000);
  });

  describe('Files and mail share blobs', () => {
    it('saves an attachment to Files and attaches a file from Files, by blob', async () => {
      const upload = await uploadBytes(new TextEncoder().encode(`hello ${RUN}`), 'text/plain');
      // Save to Files: the attachment's blob becomes a file.
      const node = await saveAttachmentToFiles({ blobId: upload.blobId, name: `${tag}.txt`, type: 'text/plain' }, null);
      createdNodes.push(node.id);
      expect(node.id).toBeTruthy();

      const nodes = await singleton.request(
        [['FileNode/get', { accountId: singleton.accountId, ids: [node.id] }, '0']],
        [CAPABILITIES.CORE, CAPABILITIES.FILES],
      );
      const stored = nodes.methodResponses[0][1].list[0];
      // Attach from Files: the file's blob goes into a draft as it is.
      const part = await attachmentFromFileNode({ ...stored, nodeType: 'file', type: 'text/plain' });
      const saved = await saveDraftVersion({
        from: [{ email: USER }], to: [{ email: USER }], subject: `files ${tag}`, textBody: 'see attached',
        attachments: [{ blobId: part.blobId, name: 'from-files.txt', type: 'text/plain', disposition: 'attachment' }],
      }, drafts);
      createdEmails.push(saved.id);
      expect(saved.attachments.map((a) => a.name)).toContain('from-files.txt');
    }, 60_000);

    const text = (buf: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(buf));
    const nodeBlob = async (id: string) => {
      const res = await singleton.request(
        [['FileNode/get', { accountId: singleton.accountId, ids: [id] }, '0']],
        [CAPABILITIES.CORE, CAPABILITIES.FILES],
      );
      return res.methodResponses[0][1].list[0] as { blobId: string; name: string };
    };

    // 0.16 made a FileNode from a part's blobId hold the whole raw message.
    it("files a message's attachment part as the attachment's bytes, under a free name, and attaches it back", async () => {
      const content = `part ${RUN}`;
      const upload = await uploadBytes(new TextEncoder().encode(content), 'text/plain');
      const draft = await saveDraftVersion({
        from: [{ email: USER }], to: [{ email: USER }], subject: `part ${tag}`, textBody: 'see attached',
        attachments: [{ blobId: upload.blobId, name: 'part.txt', type: 'text/plain', disposition: 'attachment' }],
      }, drafts);
      createdEmails.push(draft.id);
      const [full] = await getFullEmails([draft.id]);
      const part = full.attachments!.find((a) => a.name === 'part.txt')!;
      expect(part.blobId).toBeTruthy();

      const name = `${tag}-part.txt`;
      const first = await saveAttachmentToFiles({ blobId: part.blobId!, name, type: 'text/plain' }, null);
      createdNodes.push(first.id);
      const stored = await nodeBlob(first.id);
      expect(text(await singleton.fetchBlobArrayBuffer(stored.blobId, name, 'text/plain'))).toBe(content);

      // The same name again: the server would refuse it (alreadyExists).
      const second = await saveAttachmentToFiles({ blobId: part.blobId!, name, type: 'text/plain' }, null);
      createdNodes.push(second.id);
      expect(second.name).toBe(`${tag}-part (1).txt`);

      // And back: the file attached to a new draft carries the same bytes.
      const back = await attachmentFromFileNode({ ...stored, id: first.id, nodeType: 'file', type: 'text/plain' });
      const reply = await saveDraftVersion({
        from: [{ email: USER }], to: [{ email: USER }], subject: `back ${tag}`, textBody: 'see attached',
        attachments: [{ blobId: back.blobId, name: 'back.txt', type: 'text/plain', disposition: 'attachment' }],
      }, drafts);
      createdEmails.push(reply.id);
      const [again] = await getFullEmails([reply.id]);
      const attached = again.attachments!.find((a) => a.name === 'back.txt')!;
      expect(text(await singleton.fetchBlobArrayBuffer(attached.blobId!, 'back.txt', 'text/plain'))).toBe(content);
    }, 60_000);

    it('copies blobs with Blob/copy only when the blob capability is in `using`', async () => {
      const upload = await uploadBytes(new TextEncoder().encode(`copy ${RUN}`), 'text/plain');
      const call = ['Blob/copy', { fromAccountId: singleton.accountId, accountId: singleton.accountId, blobIds: [upload.blobId] }, '0'];
      const without = await singleton.request([call as never], [CAPABILITIES.CORE]);
      expect(without.methodResponses[0][0]).toBe('error');
      const withBlob = await singleton.request([call as never], [CAPABILITIES.CORE, CAPABILITIES.BLOB]);
      expect(withBlob.methodResponses[0][0]).toBe('Blob/copy');
    }, 30_000);
  });

  describe('identities', () => {
    it('sends the own address from the own account (this login is in no group)', async () => {
      await expect(resolveSendAccountId(USER)).resolves.toBe(singleton.accountId);
      expect(singleton.getSubmissionAccountIds()).toEqual([singleton.accountId]);
    }, 30_000);
  });

  describe('templates in the Inbox metadata', () => {
    it('keeps no metadata on 0.16 and asks for none', async () => {
      if (is10()) return;
      resetBulwarkMetadata();
      const request = vi.spyOn(singleton, 'request');
      expect(supportsBulwarkMetadata(singleton.accountId)).toBe(false);
      await expect(getBulwarkMetadata(singleton.accountId)).resolves.toBeNull();
      expect(request).not.toHaveBeenCalled();
      request.mockRestore();
    });

    it('writes, reads and removes an entry on 1.0, and refuses one over 8 KB', async () => {
      if (!is10()) return;
      resetBulwarkMetadata();
      const key = `template.live-${RUN}`;
      await setBulwarkMetadata(singleton.accountId, key, { id: `live-${RUN}`, name: 'Live', updatedAt: new Date().toISOString() });
      try {
        expect((await getBulwarkMetadata(singleton.accountId))?.[key]).toMatchObject({ name: 'Live' });
        await expect(setBulwarkMetadata(singleton.accountId, `template.big-${RUN}`, { body: 'x'.repeat(9000) }))
          .rejects.toBeInstanceOf(MetadataTooLargeError);
      } finally {
        await setBulwarkMetadata(singleton.accountId, key, null);
      }
      expect((await getBulwarkMetadata(singleton.accountId))?.[key]).toBeUndefined();
    }, 30_000);

    it('syncs a template made on the phone into the account, and deletes it there', async () => {
      if (!is10()) return;
      resetBulwarkMetadata();
      const before = await getBulwarkMetadata(singleton.accountId);
      const hadMarker = !!before && 'templates' in before;
      useAccountStore.setState({ activeAccountId: servedLoginOf(singleton) });
      useTemplatesStore.setState({ hydrated: true, device: [], accounts: {}, deviceListOwner: null, templates: [] });
      try {
        await useTemplatesStore.getState().refresh({ force: true });
        const made = useTemplatesStore.getState().addTemplate({ name: `Live ${RUN}`, subject: 's', body: 'b' });
        await useTemplatesStore.getState().refresh({ force: true });
        expect((await getBulwarkMetadata(singleton.accountId))?.[`template.${made.id}`]).toMatchObject({ name: `Live ${RUN}` });

        useTemplatesStore.getState().deleteTemplate(made.id);
        await useTemplatesStore.getState().refresh({ force: true });
        const after = await getBulwarkMetadata(singleton.accountId);
        expect(after?.[`template.${made.id}`]).toBeUndefined();
        expect((after?.templates as { deleted?: Record<string, string> })?.deleted?.[made.id]).toBeTruthy();
      } finally {
        if (!hadMarker) await setBulwarkMetadata(singleton.accountId, 'templates', null).catch(() => undefined);
      }
    }, 60_000);
  });
});
