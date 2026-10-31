/**
 * Live checks of Delegates (Settings > Sharing) against a real Stalwart
 * server: the first login gives the second one access to its Inbox, its
 * default calendar and its default address book in one batch, the second
 * login sees them, and taking the access away removes all of it.
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP`,
 * `BULWARK_LIVE_PASS` and `BULWARK_LIVE_USER2` are set (`BULWARK_LIVE_PASS2`
 * defaults to the first password).
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-tablet-dark@example.org BULWARK_LIVE_PASS=… \
 *   BULWARK_LIVE_USER2=e2e-tablet-land@example.org \
 *   npx vitest run src/api/__tests__/live-stalwart-delegation.test.ts
 *
 * Every grant to the second login is taken away again afterwards, also
 * after a failed check.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { JMAPClient } from '../jmap-client';
import { CAPABILITIES } from '../types';
import { applyShareChanges, getShareTargets, supportsDelegation, supportsMailboxSharing } from '../delegation';
import { buildGrantChanges, buildRevokeChanges, summarizeDelegates } from '../../lib/delegation/delegation';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const USER2 = process.env.BULWARK_LIVE_USER2;
const PASS2 = process.env.BULWARK_LIVE_PASS2 ?? PASS;
const live = SERVER && PASS && USER2 ? describe : describe.skip;

type Response = [string, Record<string, any>, string];

let owner: JMAPClient;
let delegate: JMAPClient;

async function useOwner(): Promise<void> {
  const mod = await import('../jmap-client');
  (mod.jmapClient as unknown as JMAPClient).restoreSnapshot(owner.snapshot());
}

/** Takes every grant of the delegate away (afterAll and the remove step). */
async function revokeAll(): Promise<boolean> {
  await useOwner();
  const { targets } = await getShareTargets();
  const results = await applyShareChanges(buildRevokeChanges(targets, delegate.accountId));
  return results.every((r) => r.ok);
}

/** What the delegate sees of the owner's account: its folders, calendars and address books. */
async function delegateView(): Promise<{ inSession: boolean; mailboxes: string[]; calendars: string[]; addressBooks: string[] }> {
  const session = await delegate.refreshSession();
  const id = owner.accountId;
  const inSession = !!session.accounts?.[id];
  const read = async (method: string, using: string[]) => {
    if (!inSession) return [];
    const res = (await delegate.request([[method, { accountId: id, ids: null, properties: ['id', 'name'] }, '0']], using)).methodResponses as Response[];
    return res[0][0] === method ? (res[0][1].list as { id: string }[]).map((x) => x.id) : [];
  };
  return {
    inSession,
    mailboxes: await read('Mailbox/get', [CAPABILITIES.CORE, CAPABILITIES.MAIL]),
    calendars: await read('Calendar/get', [CAPABILITIES.CORE, CAPABILITIES.CALENDARS]),
    addressBooks: await read('AddressBook/get', [CAPABILITIES.CORE, CAPABILITIES.CONTACTS]),
  };
}

live('live Stalwart: delegates', () => {
  beforeAll(async () => {
    owner = new JMAPClient();
    await owner.connect(SERVER!, USER, PASS);
    delegate = new JMAPClient();
    await delegate.connect(SERVER!, USER2!, PASS2);
    await useOwner();
  }, 60_000);

  afterAll(async () => {
    if (owner && delegate) await revokeAll().catch(() => undefined);
  }, 60_000);

  it('gives the second login the Inbox, the default calendar and address book in one step, and takes it all back', async () => {
    expect(supportsDelegation({ calendarsEnabled: true, contactsEnabled: true })).toBe(true);
    // The webmail shares folders where the account lists mail:share, on 0.16 as on 1.0.
    expect(supportsMailboxSharing()).toBe(true);

    const { targets, failed } = await getShareTargets();
    expect(failed).toEqual([]);
    const principalId = delegate.accountId;
    const changes = buildGrantChanges(targets, principalId, { mail: 'inbox', calendars: 'default', addressBooks: 'default' }, 'read');
    const inbox = targets.find((t) => t.kind === 'mailbox' && t.role === 'inbox')!;
    expect(changes.map((c) => c.id)).toContain(inbox.id);
    // One batch over every type the account has.
    for (const kind of ['calendar', 'addressBook'] as const) {
      if (targets.some((t) => t.kind === kind)) expect(changes.filter((c) => c.kind === kind)).toHaveLength(1);
    }

    const results = await applyShareChanges(changes);
    expect(results.filter((r) => !r.ok)).toEqual([]);

    // The owner's list shows the delegate with the Inbox.
    const after = await getShareTargets();
    const summary = summarizeDelegates(after.targets, [owner.accountId]).find((s) => s.principalId === principalId);
    expect(summary?.mail).toMatchObject({ shared: 1, inbox: true });
    expect(summary?.level).toBe('read');

    // The delegate sees the owner's account and exactly what was shared.
    const seen = await delegateView();
    expect(seen.inSession).toBe(true);
    expect(seen.mailboxes).toEqual([inbox.id]);
    for (const c of changes.filter((x) => x.kind === 'calendar')) expect(seen.calendars).toContain(c.id);
    for (const c of changes.filter((x) => x.kind === 'addressBook')) expect(seen.addressBooks).toContain(c.id);

    // Remove access: nothing of the owner's is left for the delegate.
    expect(await revokeAll()).toBe(true);
    const revoked = await getShareTargets();
    expect(summarizeDelegates(revoked.targets).some((s) => s.principalId === principalId)).toBe(false);
    const gone = await delegateView();
    expect(gone.mailboxes).toEqual([]);
    expect(gone.calendars.filter((id) => changes.some((c) => c.id === id))).toEqual([]);
    expect(gone.addressBooks.filter((id) => changes.some((c) => c.id === id))).toEqual([]);
  }, 120_000);
});
