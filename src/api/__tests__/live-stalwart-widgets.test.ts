/**
 * Live checks of what the home-screen widgets write, against a real Stalwart
 * server. Opt-in like live-stalwart.test.ts: skipped unless
 * `BULWARK_LIVE_JMAP` and `BULWARK_LIVE_PASS` are set.
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 BULWARK_LIVE_USER=usera@example.org \
 *   BULWARK_LIVE_PASS=… npx vitest run src/api/__tests__/live-stalwart-widgets.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { JMAPClient } from '../jmap-client';
import { CAPABILITIES } from '../types';
import { setTaskDone } from '../../widgets/jmap';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const live = SERVER && PASS ? describe : describe.skip;

const USING = [CAPABILITIES.CORE, CAPABILITIES.CALENDARS];
const RUN = `live-widgets-${Date.now().toString(36)}`;

live('live Stalwart widgets', () => {
  const client = new JMAPClient();
  const created: string[] = [];
  let calendarId = '';
  let accountId = '';

  beforeAll(async () => {
    await client.connect(SERVER!, USER, PASS);
    accountId = client.getPrimaryAccountId(CAPABILITIES.CALENDARS);
    const res = await client.request([['Calendar/get', { accountId, ids: null, properties: ['id', 'isDefault'] }, '0']], USING);
    const list = (res.methodResponses[0][1] as { list: Array<{ id: string; isDefault?: boolean }> }).list;
    calendarId = (list.find((c) => c.isDefault) ?? list[0])?.id ?? '';
    expect(calendarId).toBeTruthy();
  }, 60_000);

  afterAll(async () => {
    if (created.length) {
      await client.request([['CalendarEvent/set', { accountId, destroy: created }, '0']], USING).catch(() => undefined);
    }
  }, 30_000);

  async function createTask(title: string, extra: Record<string, unknown>): Promise<string> {
    const res = await client.request([['CalendarEvent/set', {
      accountId,
      create: { t: { '@type': 'Task', title: `${RUN} ${title}`, calendarIds: { [calendarId]: true }, timeZone: 'Europe/Berlin', ...extra } },
    }, '0']], USING);
    const body = res.methodResponses[0][1] as { created?: Record<string, { id: string }>; notCreated?: unknown };
    const id = body.created?.t?.id;
    expect(id, JSON.stringify(body.notCreated)).toBeTruthy();
    created.push(id!);
    return id!;
  }

  async function read(id: string): Promise<Record<string, any>> {
    const res = await client.request([['CalendarEvent/get', { accountId, ids: [id], properties: ['progress', 'due', 'start'] }, '0']], USING);
    return (res.methodResponses[0][1] as { list: Array<Record<string, any>> }).list[0];
  }

  // #1621: the widget's tick completed every occurrence of a repeating task.
  it('moves a repeating task to its next due date when the widget checks it off', async () => {
    // With a start: Stalwart 1.1.0 drops the rule of a task that has only a due.
    const id = await createTask('daily', {
      start: '2027-11-01T09:00:00',
      due: '2027-11-01T10:00:00',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
    });
    expect(await setTaskDone(client, id, true)).toBe(true);
    const back = await read(id);
    expect(back.progress ?? 'needs-action').toBe('needs-action');
    expect(back.due).toBe('2027-11-02T10:00:00');
    expect(back.start).toBe('2027-11-02T09:00:00');
  }, 30_000);

  it('completes a task that does not repeat', async () => {
    const id = await createTask('once', { due: '2027-11-01T10:00:00' });
    expect(await setTaskDone(client, id, true)).toBe(true);
    expect((await read(id)).progress).toBe('completed');
  }, 30_000);
});
