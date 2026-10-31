/**
 * Live checks of folder sharing (the folder menu's "Share…") against a real
 * Stalwart: the first login makes a folder, shares it with the second one,
 * changes the role, and takes the access away again.
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP`,
 * `BULWARK_LIVE_PASS` and `BULWARK_LIVE_USER2` are set (`BULWARK_LIVE_PASS2`
 * defaults to the first password).
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-perf@example.org BULWARK_LIVE_PASS=… \
 *   BULWARK_LIVE_USER2=e2e-tablet-land@example.org \
 *   npx vitest run src/api/__tests__/live-stalwart-mailbox-share.test.ts
 *
 * The folder and its share are removed afterwards, also after a failed check.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { JMAPClient } from '../jmap-client';
import { CAPABILITIES } from '../types';
import { supportsMailboxSharing } from '../delegation';
import { getMailboxShareWith, setMailboxShare } from '../mailbox-sharing';
import { createMailbox, deleteMailbox } from '../email';
import { listPrincipals } from '../files';
import { directoryNotice } from '../../lib/principal-directory';
import { detectPreset, MAILBOX_PRESETS } from '../../lib/delegation/share-rights';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const USER2 = process.env.BULWARK_LIVE_USER2;
const PASS2 = process.env.BULWARK_LIVE_PASS2 ?? PASS;
const live = SERVER && PASS && USER2 ? describe : describe.skip;

let owner: JMAPClient;
let delegate: JMAPClient;
let folderId: string | null = null;

async function useOwner(): Promise<void> {
  const mod = await import('../jmap-client');
  (mod.jmapClient as unknown as JMAPClient).restoreSnapshot(owner.snapshot());
}

/** The owner's folders the delegate can see. */
async function delegateSees(): Promise<string[]> {
  const session = await delegate.refreshSession();
  if (!session.accounts?.[owner.accountId]) return [];
  const res = await delegate.request(
    [['Mailbox/get', { accountId: owner.accountId, ids: null, properties: ['id'] }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.MAIL],
  );
  const [method, body] = (res.methodResponses ?? [])[0] as [string, { list?: { id: string }[] }, string];
  return method === 'Mailbox/get' ? (body.list ?? []).map((m) => m.id) : [];
}

live('live Stalwart: folder sharing', () => {
  beforeAll(async () => {
    owner = new JMAPClient();
    await owner.connect(SERVER!, USER, PASS);
    delegate = new JMAPClient();
    await delegate.connect(SERVER!, USER2!, PASS2);
    await useOwner();
  }, 60_000);

  afterAll(async () => {
    if (!owner || !folderId) return;
    await useOwner();
    await setMailboxShare(folderId, delegate.accountId, null).catch(() => undefined);
    await deleteMailbox(folderId, undefined, { onDestroyRemoveEmails: true }).catch(() => undefined);
  }, 60_000);

  it('shares a folder read-only, upgrades it, and takes it back', async () => {
    expect(supportsMailboxSharing()).toBe(true);
    folderId = await createMailbox({ name: `Bulwark share check ${Date.now()}` });
    const principalId = delegate.accountId;

    // Nobody yet: Stalwart answers {} (or null).
    expect(Object.keys((await getMailboxShareWith(folderId)) ?? {})).toEqual([]);

    await setMailboxShare(folderId, principalId, MAILBOX_PRESETS.read);
    const afterRead = await getMailboxShareWith(folderId);
    expect(afterRead?.[principalId]).toBeTruthy();
    // 1.0 stores the keyword right with the seen right; still "Read only".
    expect(detectPreset('mailbox', afterRead![principalId])).toBe('read');
    expect(await delegateSees()).toContain(folderId);

    await setMailboxShare(folderId, principalId, MAILBOX_PRESETS.readWrite);
    const afterWrite = await getMailboxShareWith(folderId);
    expect(detectPreset('mailbox', afterWrite![principalId])).toBe('readWrite');

    await setMailboxShare(folderId, principalId, null);
    const afterRemove = await getMailboxShareWith(folderId);
    expect(afterRemove?.[principalId]).toBeFalsy();
    expect(await delegateSees()).not.toContain(folderId);
  }, 60_000);

  // Stalwart 1.0 hides the directory unless the admin turns directory
  // queries on: the sheet then says why the list is short and names a
  // sharee it can't resolve "Unknown user". 0.16 lists everyone.
  it('either lists the person shared with or explains why the list is short', async () => {
    const listing = await listPrincipals();
    const listed = listing.principals.some((p) => p.id === delegate.accountId);
    const notice = directoryNotice(listing);
    expect(listed || notice !== null).toBe(true);
    if (!listed) expect(notice).toBe('restricted');
  }, 60_000);
});
