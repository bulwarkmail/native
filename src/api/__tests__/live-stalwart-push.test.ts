/**
 * Live push subscription checks against a real Stalwart server.
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP` and
 * `BULWARK_LIVE_PASS` are set. No device is involved (there is no FCM or APNs
 * token here): it drives the PushSubscription calls the app makes, with the
 * URLs, types and emailPush maps the app builds, and destroys every
 * subscription it creates.
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-tablet-dark@example.org \
 *   BULWARK_LIVE_PASS=… npx vitest run src/api/__tests__/live-stalwart-push.test.ts
 *
 * `BULWARK_LIVE_PUSH_RELAY=1` also runs the verification round trip through
 * the hosted relay (https://notifications.relay.bulwarkmail.org): the server
 * posts PushVerification there and the test reads it back the way the app's
 * poll does. It registers a throwaway record with the relay under a random
 * id and removes it again. Run it at least a minute after any other push
 * test against the same account: Stalwart sends one PushVerification per
 * account per minute.
 *
 * Verified against stalwartlabs/stalwart:v0.16.27 and v1.0.0.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';

import { JMAPClient } from '../jmap-client';
import {
  createPushSubscription,
  destroyPushSubscription,
  listPushSubscriptions,
  updatePushSubscription,
  verifyPushSubscription,
} from '../push';
import { isJMAPSetError, JMAPSetError } from '../jmap-result';
import { getMailboxes } from '../email';
import {
  buildEmailPushConfig,
  DEFAULT_RELAY_BASE_URL,
  emailPushFallbacks,
  EMAIL_PUSH_CAPABILITY,
  sameEmailPush,
  sameTypes,
} from '../../lib/push-notifications';
import type { EmailPushConfig } from '../types';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const live = SERVER && PASS ? describe : describe.skip;
const withRelay = process.env.BULWARK_LIVE_PUSH_RELAY === '1' ? it : it.skip;

const DAY = 86_400_000;
// What pushTypesFor gives an account that syncs contacts and calendars.
const ALL_TYPES = ['EmailDelivery', 'ContactCard', 'AddressBook', 'CalendarEvent', 'Calendar'];

let client: JMAPClient;

async function connectSingleton(): Promise<void> {
  const mod = await import('../jmap-client');
  client = new JMAPClient();
  await client.connect(SERVER!, USER, PASS);
  (mod.jmapClient as unknown as JMAPClient).restoreSnapshot(client.snapshot());
}

/** Stalwart 1.0 lists principals:owner in the account capabilities, 0.16 doesn't. */
function isStalwart1(): boolean {
  const caps = client.currentSession?.accounts?.[client.accountId]?.accountCapabilities ?? {};
  return 'urn:ietf:params:jmap:principals:owner' in caps;
}

live('live Stalwart push subscriptions', () => {
  const run = randomBytes(4).toString('hex');
  const deviceClientId = (label: string) => `live-push-${run}-${label}`;
  // The URL the app subscribes with (setupPushNotifications).
  const relayUrl = (dcid: string) => `${DEFAULT_RELAY_BASE_URL}/api/push/jmap/${encodeURIComponent(dcid)}`;
  const created: string[] = [];
  let junk = '';
  let inbox = '';

  async function create(label: string, params: Partial<Parameters<typeof createPushSubscription>[0]> = {}) {
    const dcid = deviceClientId(label);
    const result = await createPushSubscription({
      deviceClientId: dcid,
      url: relayUrl(dcid),
      types: ['EmailDelivery'],
      expires: new Date(Date.now() + 90 * DAY).toISOString(),
      ...params,
    });
    created.push(result.id);
    return result;
  }

  async function refusal(promise: Promise<unknown>): Promise<JMAPSetError> {
    const err = await promise.then(
      (value) => {
        // A create that went through still has to be cleaned up.
        const id = (value as { id?: string } | undefined)?.id;
        if (id) created.push(id);
        return null;
      },
      (e: unknown) => e,
    );
    expect(isJMAPSetError(err), String(err)).toBe(true);
    return err as JMAPSetError;
  }

  beforeAll(async () => {
    await connectSingleton();
    const boxes = await getMailboxes();
    junk = boxes.find((b) => b.role === 'junk')?.id ?? '';
    inbox = boxes.find((b) => b.role === 'inbox')?.id ?? '';
    expect(inbox).toBeTruthy();
    expect(junk).toBeTruthy();
  }, 60_000);

  afterAll(async () => {
    // Everything this run made, also what a failed assertion left behind.
    const left = await listPushSubscriptions().catch(() => []);
    const ids = new Set([...created, ...left.filter((s) => s.deviceClientId.startsWith('live-push-')).map((s) => s.id)]);
    for (const id of ids) await destroyPushSubscription(id).catch(() => undefined);
  }, 60_000);

  // First, so earlier creates of this run don't hold the verification slot.
  withRelay('delivers PushVerification to the hosted relay and accepts the code', async () => {
    const dcid = `liveprobe-${randomBytes(8).toString('hex')}`;
    const relay = (path: string, init?: RequestInit) => fetch(`${DEFAULT_RELAY_BASE_URL}${path}`, init);
    const registered = await relay('/api/push/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscriptionId: dcid, fcmToken: `liveprobe${'x'.repeat(100)}`, accountLabel: 'live test (delete me)' }),
    });
    expect(registered.status).toBe(200);
    try {
      const { id } = await createPushSubscription({ deviceClientId: dcid, url: relayUrl(dcid), types: ['EmailDelivery'] });
      created.push(id);
      // The app's poll: up to 75 s, enough for one verification window.
      let code: string | null = null;
      const until = Date.now() + 75_000;
      while (!code && Date.now() < until) {
        const res = await relay(`/api/push/verify/${dcid}`);
        if (res.ok) code = ((await res.json()) as { verificationCode?: string | null }).verificationCode ?? null;
        if (!code) await new Promise((r) => setTimeout(r, 1000));
      }
      expect(code).toBeTruthy();
      await expect(verifyPushSubscription(id, 'not-the-code')).rejects.toMatchObject({ type: 'invalidProperties' });
      await verifyPushSubscription(id, code!);
    } finally {
      await relay(`/api/push/register/${dcid}`, { method: 'DELETE' });
    }
  }, 120_000);

  it('advertises emailpush, on the own account too', () => {
    expect(EMAIL_PUSH_CAPABILITY in (client.currentSession?.capabilities ?? {})).toBe(true);
    expect(EMAIL_PUSH_CAPABILITY in (client.currentSession?.accounts?.[client.accountId]?.accountCapabilities ?? {})).toBe(true);
  });

  it('creates the subscription the app makes and clamps its expiry to seven days', async () => {
    const emailPush = await buildEmailPushConfig();
    expect(Object.keys(emailPush)).toContain(client.accountId);
    const { id, expires } = await create('full', { types: ALL_TYPES, emailPush });
    const left = Date.parse(expires ?? '') - Date.now();
    expect(left).toBeGreaterThan(7 * DAY - 5 * 60_000);
    expect(left).toBeLessThanOrEqual(7 * DAY + 60_000);

    // Read back as the app compares it, so a launch doesn't re-patch it.
    const listed = (await listPushSubscriptions()).find((s) => s.id === id);
    expect(listed?.deviceClientId).toBe(deviceClientId('full'));
    expect(sameTypes(listed?.types, ALL_TYPES)).toBe(true);
    expect(sameEmailPush(listed?.emailPush, emailPush), JSON.stringify(listed?.emailPush)).toBe(true);
  }, 30_000);

  it('takes the refresh the launch sends: expiry, types and filter in one update', async () => {
    const { id } = await create('refresh', { types: ALL_TYPES });
    const emailPush = await buildEmailPushConfig();
    await updatePushSubscription(id, { expires: new Date(Date.now() + 90 * DAY).toISOString(), types: ['EmailDelivery'], emailPush });
    const listed = (await listPushSubscriptions()).find((s) => s.id === id);
    expect(listed?.types).toEqual(['EmailDelivery']);
    expect(sameEmailPush(listed?.emailPush, emailPush)).toBe(true);
    expect(Date.parse(listed?.expires ?? '') - Date.now()).toBeLessThanOrEqual(7 * DAY + 60_000);

    // A record that is gone answers notFound, which the setup answers with a
    // replacement; destroying it again counts as done.
    await destroyPushSubscription(id);
    expect((await refusal(updatePushSubscription(id, { expires: new Date(Date.now() + DAY).toISOString() }))).type).toBe('notFound');
    await destroyPushSubscription(id);
  }, 30_000);

  it('refuses a map naming an account the user is not a member of as forbidden, and takes the narrowed one', async () => {
    const own = await buildEmailPushConfig();
    // Account ids are short and sequential; one the user doesn't belong to.
    const foreign = ['a', 'b', 'c', 'd', 'e'].find((id) => !(id in (client.currentSession?.accounts ?? {})))!;
    const wanted: Record<string, EmailPushConfig> = { ...own, [foreign]: own[client.accountId] };

    const refused = await refusal(create('foreign', { emailPush: wanted }));
    expect(refused.type).toBe('forbidden');

    // What the setup tries next: the primary account alone.
    const attempts = emailPushFallbacks(wanted, client.accountId, client.currentSession?.accounts);
    expect(Object.keys(attempts[attempts.length - 1])).toEqual([client.accountId]);
    const { id } = await create('narrowed', { emailPush: attempts[attempts.length - 1] });

    // An update is refused the same way and leaves the subscription as it was.
    expect((await refusal(updatePushSubscription(id, { emailPush: wanted }))).type).toBe('forbidden');
    expect(sameEmailPush((await listPushSubscriptions()).find((s) => s.id === id)?.emailPush, own)).toBe(true);
  }, 30_000);

  it('takes the filters mutes produce and echoes them so they compare equal (#78)', async () => {
    const me = client.accountId;
    const cases = {
      folderMuted: { accounts: [], mailboxes: { [`${me}/${inbox}`]: true } },
      accountMutedInboxUnmuted: { accounts: [me], mailboxes: { [`${me}/${inbox}`]: false } },
      accountMuted: { accounts: [me], mailboxes: {} },
    };
    const built = Object.fromEntries(await Promise.all(
      Object.entries(cases).map(async ([name, mutes]) => [name, await buildEmailPushConfig(mutes)] as const),
    ));
    expect(built.folderMuted[me].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailboxOtherThan: [inbox, junk].sort() }],
    });
    expect(built.accountMutedInboxUnmuted[me].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { inMailbox: inbox }],
    });
    expect(built.accountMuted[me].filter).toEqual({
      operator: 'AND',
      conditions: [{ notKeyword: '$junk' }, { hasKeyword: '$junk' }],
    });
    for (const [name, emailPush] of Object.entries(built)) {
      const { id } = await create(`mute-${name}`, { emailPush });
      const listed = (await listPushSubscriptions()).find((s) => s.id === id);
      expect(sameEmailPush(listed?.emailPush, emailPush), `${name}: ${JSON.stringify(listed?.emailPush)}`).toBe(true);
    }
  }, 60_000);

  it('refuses push addresses that are not public: http and private IPs everywhere, local names on 1.0', async () => {
    for (const url of ['http://notifications.relay.bulwarkmail.org/api/push/jmap/x', 'https://192.168.1.20/api/push/jmap/x', 'https://10.0.0.5:8443/api/push/jmap/x']) {
      const err = await refusal(create('private-ip', { url }));
      expect(err.type).toBe('invalidProperties');
      expect(err.properties).toEqual(['url']);
    }
    for (const url of ['https://relay.home.lan/api/push/jmap/x', 'https://relay.local/api/push/jmap/x', 'https://localhost/api/push/jmap/x']) {
      if (isStalwart1()) {
        const err = await refusal(create('local-name', { url }));
        expect(err.type).toBe('invalidProperties');
        expect(err.properties).toEqual(['url']);
        expect(err.message).toContain('public domain');
      } else {
        // 0.16 takes them; it would only fail to deliver.
        await create('local-name', { url });
      }
    }
  }, 30_000);

  it('refuses a type it does not know over the types property', async () => {
    const err = await refusal(create('bogus-type', { types: ['EmailDelivery', 'NoSuchType'] }));
    expect(err.type).toBe('invalidProperties');
    expect(err.properties).toEqual(['types']);
  });

  it('caps the subscriptions of an account and says so with overQuota', async () => {
    let err: JMAPSetError | null = null;
    for (let i = 0; i < 30 && !err; i++) {
      err = await create(`cap-${i}`).then(() => null, (e: unknown) => (isJMAPSetError(e) ? e : Promise.reject(e)));
    }
    expect(err?.type).toBe('overQuota');
    expect((await listPushSubscriptions()).length).toBe(15);
  }, 60_000);
});
