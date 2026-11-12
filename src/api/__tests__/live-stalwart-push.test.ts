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
import { createRequire } from 'node:module';

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
import { createStateBaseline, startLiveUpdates } from '../push-stream';
import type { EmailPushConfig, StateChange } from '../types';
import { archiveFromNotification } from '../../lib/notification-mail-actions';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const live = SERVER && PASS ? describe : describe.skip;
const withRelay = process.env.BULWARK_LIVE_PUSH_RELAY === '1' ? it : it.skip;

const DAY = 86_400_000;
// What pushTypesFor gives an account that syncs contacts and calendars.
const ALL_TYPES = ['EmailDelivery', 'ContactCard', 'AddressBook', 'CalendarEvent', 'Calendar'];

let client: JMAPClient;

const nodeRequire = createRequire(import.meta.url);

/** The react-native-sse surface push-stream uses, over Node's fetch. */
class NodeEventSource {
  private listeners = new Map<string, Set<(event: { type: string; data?: string; xhrStatus?: number }) => void>>();
  private abort = new AbortController();

  constructor(url: string, options: { headers: Record<string, string> }) {
    void this.run(url, options.headers);
  }

  addEventListener(type: string, handler: (event: { type: string; data?: string; xhrStatus?: number }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  removeEventListener(type: string, handler: (event: { type: string; data?: string; xhrStatus?: number }) => void) {
    this.listeners.get(type)?.delete(handler);
  }

  close() {
    this.abort.abort();
  }

  private emit(type: string, event: { data?: string; xhrStatus?: number } = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ type, ...event });
  }

  private async run(url: string, headers: Record<string, string>) {
    try {
      const res = await fetch(url, { headers: { ...headers, Accept: 'text/event-stream' }, signal: this.abort.signal });
      if (!res.ok || !res.body) {
        this.emit('error', { xhrStatus: res.status });
        return;
      }
      this.emit('open');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let m = /\r?\n\r?\n/.exec(buffer); m; m = /\r?\n\r?\n/.exec(buffer)) {
          const block = buffer.slice(0, m.index);
          buffer = buffer.slice(m.index + m[0].length);
          let type = 'message';
          const data: string[] = [];
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          this.emit(type, { data: data.join('\n') });
        }
      }
      if (!this.abort.signal.aborted) this.emit('close');
    } catch {
      if (!this.abort.signal.aborted) this.emit('error', { xhrStatus: 0 });
    }
  }
}

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

  it('answers a lookup it cannot serve with an error response, not an empty list (bulwarkmail/webmail#1041)', async () => {
    // The background task's Email/get for a push names the account the push
    // came for; one the login can't read must read as a failed lookup (which
    // shows a generic notification), not as "nothing new".
    const res = await client.request([['Email/get', { accountId: 'zzzz', ids: ['x'], properties: ['id'] }, '0']]);
    const [name, body] = res.methodResponses[0] as unknown as [string, { type?: string }];
    expect(name).toBe('error');
    expect(typeof body.type).toBe('string');
  });

  it('takes the Inbox-only filter and echoes it so it compares equal (bulwarkmail/webmail#983)', async () => {
    const me = client.accountId;
    const emailPush = await buildEmailPushConfig(undefined, true);
    expect(emailPush[me].filter).toEqual({ operator: 'AND', conditions: [{ notKeyword: '$junk' }, { inMailbox: inbox }] });
    const { id } = await create('inbox-only', { emailPush });
    const listed = (await listPushSubscriptions()).find((s) => s.id === id);
    expect(sameEmailPush(listed?.emailPush, emailPush), JSON.stringify(listed?.emailPush)).toBe(true);
  }, 30_000);

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

  it('answers an update without the expiry it settled on, which a read gives back', async () => {
    const { id } = await create('readback');
    const res = await client.request(
      [['PushSubscription/set', { update: { [id]: { expires: new Date(Date.now() + 90 * DAY).toISOString() } } }, '0']],
      ['urn:ietf:params:jmap:core'],
    );
    const updated = (res.methodResponses[0][1] as { updated?: Record<string, unknown> }).updated ?? {};
    expect(id in updated).toBe(true);
    // null or an object without `expires`: the setup has to read it back.
    expect((updated[id] as { expires?: unknown } | null)?.expires).toBeUndefined();
    const left = Date.parse((await listPushSubscriptions()).find((s) => s.id === id)?.expires ?? '') - Date.now();
    expect(left).toBeGreaterThan(7 * DAY - 5 * 60_000);
    expect(left).toBeLessThanOrEqual(7 * DAY + 60_000);
  }, 30_000);

  it("gives a destroyed subscription's id to the next one, whoever creates it", async () => {
    // Why the app compares the device client id and not the id alone.
    const first = await create('reused-a');
    await destroyPushSubscription(first.id);
    const second = await create('reused-b');
    expect(second.id).toBe(first.id);
    const listed = (await listPushSubscriptions()).find((s) => s.id === first.id);
    expect(listed?.deviceClientId).toBe(deviceClientId('reused-b'));
  }, 30_000);

  it('takes a notification Delete that moves to Trash and marks read in one update (#86)', async () => {
    const boxes = await getMailboxes();
    const trash = boxes.find((b) => b.role === 'trash')?.id;
    expect(trash).toBeTruthy();
    const using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
    const made = await client.request([[
      'Email/set',
      {
        accountId: client.accountId,
        create: {
          probe: {
            mailboxIds: { [inbox]: true },
            keywords: {},
            from: [{ email: 'probe@example.org' }],
            subject: `live push probe ${run}`,
            bodyValues: { b: { value: 'probe' } },
            textBody: [{ partId: 'b', type: 'text/plain' }],
          },
        },
      },
      '0',
    ]], using);
    const emailId = (made.methodResponses[0][1] as { created?: Record<string, { id: string }> }).created?.probe?.id;
    expect(emailId, JSON.stringify(made.methodResponses[0][1])).toBeTruthy();
    try {
      // What handleNotificationAction sends with "Move to Trash and mark as read".
      const res = await client.request([[
        'Email/set',
        { accountId: client.accountId, update: { [emailId!]: { mailboxIds: { [trash!]: true }, 'keywords/$seen': true } } },
        '0',
      ]], using);
      expect(Object.keys((res.methodResponses[0][1] as { updated?: object }).updated ?? {})).toEqual([emailId]);
      const got = await client.request([[
        'Email/get',
        { accountId: client.accountId, ids: [emailId], properties: ['mailboxIds', 'keywords'] },
        '0',
      ]], using);
      const email = (got.methodResponses[0][1] as { list: Array<{ mailboxIds: object; keywords: object }> }).list[0];
      expect(email.mailboxIds).toEqual({ [trash!]: true });
      expect(email.keywords).toMatchObject({ $seen: true });
    } finally {
      await client.request([['Email/set', { accountId: client.accountId, destroy: [emailId] }, '0']], using);
    }
  }, 30_000);

  // Webmail #1553: a reopened event stream doesn't replay what it missed, so
  // every (re)connect checks the states once. The stream here is the real
  // event source over Node's fetch (react-native-sse needs XHR).
  describe('catch-up after the live connection was down', () => {
    const CONTACTS_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:contacts'];
    const MAIL_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
    const streams: NodeEventSource[] = [];
    const cards: string[] = [];
    const emails: string[] = [];
    let bookId = '';

    beforeAll(async () => {
      const ssePath = nodeRequire.resolve('react-native-sse');
      nodeRequire.cache[ssePath] = {
        id: ssePath, filename: ssePath, loaded: true, exports: { default: NodeEventSource },
      } as NodeJS.Module;
      streams.length = 0;
      const books = await client.request([['AddressBook/get', { accountId: client.accountId, ids: null }, '0']], CONTACTS_USING);
      const list = (books.methodResponses[0][1] as { list: Array<{ id: string; isDefault?: boolean }> }).list;
      bookId = (list.find((b) => b.isDefault) ?? list[0])?.id ?? '';
      expect(bookId).toBeTruthy();
    }, 30_000);

    afterAll(async () => {
      for (const s of streams) s.close();
      if (cards.length) {
        await client.request([['ContactCard/set', { accountId: client.accountId, destroy: cards }, '0']], CONTACTS_USING).catch(() => undefined);
      }
      if (emails.length) {
        await client.request([['Email/set', { accountId: client.accountId, destroy: emails }, '0']], MAIL_USING).catch(() => undefined);
      }
    }, 30_000);

    /** A change the app didn't make, by the second client while no stream is open. */
    async function changeElsewhere(label: string): Promise<void> {
      const res = await client.request([
        ['ContactCard/set', {
          accountId: client.accountId,
          create: { c: { '@type': 'Card', version: '1.0', uid: `urn:uuid:live-push-${run}-${label}`, name: { full: `Live catch-up ${run} ${label}` }, addressBookIds: { [bookId]: true } } },
        }, '0'],
      ], CONTACTS_USING);
      const card = (res.methodResponses[0][1] as { created?: Record<string, { id: string }> }).created?.c?.id;
      expect(card, JSON.stringify(res.methodResponses[0][1])).toBeTruthy();
      cards.push(card!);
      const made = await client.request([[
        'Email/set',
        { accountId: client.accountId, create: { e: { mailboxIds: { [inbox]: true }, keywords: { $seen: true }, from: [{ email: 'probe@example.org' }], subject: `live catch-up ${run} ${label}`, bodyValues: { b: { value: 'probe' } }, textBody: [{ partId: 'b', type: 'text/plain' }] } } },
        '0',
      ]], MAIL_USING);
      const email = (made.methodResponses[0][1] as { created?: Record<string, { id: string }> }).created?.e?.id;
      expect(email, JSON.stringify(made.methodResponses[0][1])).toBeTruthy();
      emails.push(email!);
      // Past Stalwart's push throttle, so a stream opened next can't get the event itself.
      await new Promise((r) => setTimeout(r, 3_000));
    }

    async function until(check: () => boolean, ms: number): Promise<boolean> {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (check()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return check();
    }

    function reported(seen: StateChange[], type: string): boolean {
      return seen.some((c) => type in (c.changed[client.accountId] ?? {}));
    }

    it('reports a contact and a mail made while the stream was paused, after it reconnects', async () => {
      const seen: StateChange[] = [];
      let active = true;
      const handle = await startLiveUpdates({ onStateChange: (c) => seen.push(c), isActive: () => active });
      try {
        expect(handle.mode).toBe('sse');
        expect(await until(() => handle.healthy, 15_000)).toBe(true);
        // The first check only primes the baseline.
        await new Promise((r) => setTimeout(r, 3_000));
        expect(reported(seen, 'ContactCard')).toBe(false);

        // Pause: the stream drops and stays down while the app is inactive.
        active = false;
        handle.reconnect();
        expect(handle.healthy).toBe(false);
        await changeElsewhere('paused');

        active = true;
        handle.reconnect();
        expect(await until(() => reported(seen, 'ContactCard') && reported(seen, 'Email'), 15_000), JSON.stringify(seen)).toBe(true);
      } finally {
        handle.close();
      }
    }, 60_000);

    it('reports a change made while the app had closed the stream, with the baseline carried over', async () => {
      const baseline = createStateBaseline();
      const first = await startLiveUpdates({ onStateChange: () => undefined, baseline });
      try {
        expect(await until(() => first.healthy, 15_000)).toBe(true);
        await new Promise((r) => setTimeout(r, 3_000));
      } finally {
        first.close();
      }
      expect(Object.keys(baseline.known)).toContain(`${client.accountId}:ContactCard`);
      await changeElsewhere('closed');

      const seen: StateChange[] = [];
      const second = await startLiveUpdates({ onStateChange: (c) => seen.push(c), baseline });
      try {
        expect(await until(() => reported(seen, 'ContactCard'), 15_000), JSON.stringify(seen)).toBe(true);
      } finally {
        second.close();
      }
    }, 60_000);
  });

  // Archive from a notification (webmail public/sw.js, app/api/push/action):
  // the request the JS task sends, which the native path mirrors.
  it('archives from a notification into year and month folders, made in the same request', async () => {
    const using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
    const post = async (calls: Array<[string, Record<string, unknown>, string]>) =>
      (await client.request(calls, using)).methodResponses as Array<[string, Record<string, any>, string]>;
    const before = await getMailboxes();
    const known = new Set(before.map((b) => b.id));
    const made = await client.request([[
      'Email/set',
      {
        accountId: client.accountId,
        create: {
          probe: {
            mailboxIds: { [inbox]: true },
            keywords: {},
            from: [{ email: 'probe@example.org' }],
            subject: `live archive probe ${run}`,
            // Far enough back that the year and month folders are new.
            receivedAt: '2011-03-15T12:00:00Z',
            bodyValues: { b: { value: 'probe' } },
            textBody: [{ partId: 'b', type: 'text/plain' }],
          },
        },
      },
      '0',
    ]], using);
    const emailId = (made.methodResponses[0][1] as { created?: Record<string, { id: string }> }).created?.probe?.id;
    expect(emailId, JSON.stringify(made.methodResponses[0][1])).toBeTruthy();
    let fresh: string[] = [];
    try {
      expect(await archiveFromNotification(post, client.accountId, emailId!, 'month')).toBe('archived');
      const after = await getMailboxes();
      fresh = after.filter((b) => !known.has(b.id)).map((b) => b.id);
      const archive = after.find((b) => b.role === 'archive') ?? after.find((b) => b.name.toLowerCase() === 'archive');
      const year = after.find((b) => b.parentId === archive?.id && b.name === '2011');
      const month = after.find((b) => b.parentId === year?.id && b.name === '03');
      expect(month, JSON.stringify(after.map((b) => [b.name, b.parentId]))).toBeTruthy();
      const got = await client.request([['Email/get', { accountId: client.accountId, ids: [emailId], properties: ['mailboxIds'] }, '0']], using);
      expect((got.methodResponses[0][1] as { list: Array<{ mailboxIds: object }> }).list[0].mailboxIds).toEqual({ [month!.id]: true });
    } finally {
      await client.request([['Email/set', { accountId: client.accountId, destroy: [emailId] }, '0']], using);
      // Deepest first: the month, then the year, then an Archive folder this run made.
      const boxes = await getMailboxes();
      const depth = (id: string): number => {
        const parent = boxes.find((b) => b.id === id)?.parentId;
        return parent ? 1 + depth(parent) : 0;
      };
      for (const id of [...fresh].sort((a, b) => depth(b) - depth(a))) {
        await client.request([['Mailbox/set', { accountId: client.accountId, destroy: [id] }, '0']], using).catch(() => undefined);
      }
    }
  }, 60_000);

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

    // At the cap the count is checked before the address: a forced
    // re-register to a relay the server refuses sees overQuota first, which
    // is why the setup doesn't free a place for a new relay.
    const refused = await refusal(create('cap-refused-url', { url: 'https://10.0.0.5:8443/api/push/jmap/x' }));
    expect(refused.type).toBe('overQuota');
  }, 60_000);
});
