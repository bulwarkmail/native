import { describe, expect, it } from 'vitest';
import {
  Attendees,
  Calendars,
  Data,
  Events,
  MimeType,
  RawContacts,
  StructuredName,
  StructuredPostal,
} from '../android-columns';
import { CALENDAR_AUTHORITY, CONTACTS_AUTHORITY, type ProviderOp } from '../types';
import { JPEG } from './contacts/fixtures';
import { FakeDeviceProviders, aospDurationValid, aospRruleValid } from './fakes/fake-provider';
import { compileWhere } from './fakes/fake-sql';

const ME = 'usera@example.org';
const OTHER = 'someone@example.org';

async function contactWithEmail(fake: FakeDeviceProviders, account = ME) {
  const port = fake.port(account, CONTACTS_AUTHORITY);
  const res = await port.applyBatch([
    { op: 'insert', table: 'raw_contacts', values: { [RawContacts.SOURCE_ID]: 'c/e1' } },
    {
      op: 'insert',
      table: 'data',
      values: { [Data.MIMETYPE]: MimeType.EMAIL, [Data.DATA1]: 'a@example.org', [Data.DATA_SYNC1]: 'emails:e1' },
      refs: { [Data.RAW_CONTACT_ID]: 0 },
    },
  ]);
  if (!res.ok) throw new Error(res.message);
  return { port, rawId: res.results[0].id!, dataId: res.results[1].id! };
}

describe('fake-sql', () => {
  const row = (r: Record<string, string | number | null>) => (c: string) => r[c] ?? null;

  it('evaluates the documented subset with SQL precedence and NULL rules', () => {
    const where = compileWhere('dirty = 1 OR deleted = 1 AND sourceid IS NOT NULL', []);
    expect(where(row({ dirty: 0, deleted: 1, sourceid: null }))).toBe(false);
    expect(where(row({ dirty: 1, deleted: 0, sourceid: null }))).toBe(true);
    expect(compileWhere('x IN (?, ?, 3)', ['1', 2])(row({ x: 3 }))).toBe(true);
    expect(compileWhere('x NOT IN (?)', ['1'])(row({ x: null }))).toBe(false);
    expect(compileWhere("mimetype LIKE '%/email%'")(row({ mimetype: 'vnd.android.cursor.item/email_v2' }))).toBe(true);
    expect(compileWhere('version = ?', ['2'])(row({ version: 2 }))).toBe(true);
    expect(compileWhere('NOT (a = 1)')(row({ a: null }))).toBe(true);
    expect(() => compileWhere('a = ?', [])).toThrow(/placeholders/);
  });
});

describe('FakeDeviceProviders: contacts', () => {
  it('scopes every read and write to the port account', async () => {
    const fake = new FakeDeviceProviders();
    const mine = await contactWithEmail(fake, ME);
    const theirs = await contactWithEmail(fake, OTHER);
    const rows = await mine.port.query({ table: 'raw_contacts', columns: [RawContacts._ID] });
    expect(rows.rows).toEqual([[mine.rawId]]);
    const data = await mine.port.query({ table: 'data', columns: [Data._ID] });
    expect(data.rows).toEqual([[mine.dataId]]);
    const denied = await mine.port.applyBatch([{ op: 'update', table: 'raw_contacts', id: theirs.rawId, values: { [RawContacts.SYNC1]: 'x' } }]);
    expect(denied).toMatchObject({ ok: false, reason: 'scope' });
    const orphan = await mine.port.applyBatch([
      { op: 'insert', table: 'data', values: { [Data.RAW_CONTACT_ID]: theirs.rawId, [Data.MIMETYPE]: MimeType.NOTE } },
    ]);
    expect(orphan).toMatchObject({ ok: false, reason: 'scope' });
    await expect(mine.port.query({ table: 'events', columns: ['_id'] })).rejects.toMatchObject({ code: 'scope' });
  });

  it('never sets DIRTY for the sync adapter but does for app edits, and only apps soft-delete', async () => {
    const fake = new FakeDeviceProviders();
    const { rawId, dataId } = await contactWithEmail(fake);
    expect(fake.row('raw_contacts', rawId)![RawContacts.DIRTY]).toBe(0);
    fake.user.updateData(dataId, { [Data.DATA1]: 'b@example.org' });
    expect(fake.row('raw_contacts', rawId)![RawContacts.DIRTY]).toBe(1);
    expect(fake.row('data', dataId)![Data.DATA_SYNC1]).toBe('emails:e1');
    fake.user.deleteContact(rawId);
    expect(fake.row('raw_contacts', rawId)).toMatchObject({ [RawContacts.DELETED]: 1, [RawContacts.DIRTY]: 1 });
    const port = fake.port(ME, CONTACTS_AUTHORITY);
    await port.applyBatch([{ op: 'delete', table: 'raw_contacts', id: rawId }]);
    expect(fake.row('raw_contacts', rawId)).toBeUndefined();
    expect(fake.row('data', dataId)).toBeUndefined();
  });

  it('bumps VERSION for data writes by anyone but not for DIRTY, SOURCE_ID or SYNC columns', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId, dataId } = await contactWithEmail(fake);
    const version = () => fake.row('raw_contacts', rawId)![RawContacts.VERSION];
    expect(version()).toBe(2); // one bump for the batch's data inserts
    await port.applyBatch([
      { op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.DIRTY]: 0, [RawContacts.SYNC2]: '{}', [RawContacts.SOURCE_ID]: 'c/e2' } },
    ]);
    expect(version()).toBe(2);
    await port.applyBatch([{ op: 'update', table: 'data', id: dataId, values: { [Data.DATA_SYNC3]: '{}' } }]);
    expect(version()).toBe(3);
    fake.user.star(rawId);
    expect(version()).toBe(3);
    expect(fake.row('raw_contacts', rawId)![RawContacts.DIRTY]).toBe(1);
  });

  it('applies a batch atomically and fails it on a stale VERSION assert', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId, dataId } = await contactWithEmail(fake);
    fake.user.updateData(dataId, { [Data.DATA1]: 'edited@example.org' });
    const clear: ProviderOp[] = [
      { op: 'assert', table: 'raw_contacts', id: rawId, values: { [RawContacts.VERSION]: 2 } },
      { op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.DIRTY]: 0 } },
    ];
    expect(await port.applyBatch(clear)).toMatchObject({ ok: false, reason: 'assert' });
    expect(fake.row('raw_contacts', rawId)![RawContacts.DIRTY]).toBe(1);
    const current = fake.row('raw_contacts', rawId)![RawContacts.VERSION] as number;
    const ok = await port.applyBatch([
      { op: 'assert', table: 'raw_contacts', id: rawId, values: { [RawContacts.VERSION]: current } },
      { op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.DIRTY]: 0 } },
      { op: 'syncState', value: '{"v":1}' },
    ]);
    expect(ok.ok).toBe(true);
    expect(fake.readSyncState(ME, CONTACTS_AUTHORITY)).toBe('{"v":1}');
  });

  it('runs a hook right before the next batch, for concurrent-edit tests', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId, dataId } = await contactWithEmail(fake);
    const v = fake.row('raw_contacts', rawId)![RawContacts.VERSION] as number;
    fake.beforeNextBatch(() => fake.user.updateData(dataId, { [Data.DATA1]: 'late@example.org' }));
    const res = await port.applyBatch([
      { op: 'assert', table: 'raw_contacts', id: rawId, values: { [RawContacts.VERSION]: v } },
      { op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.DIRTY]: 0 } },
    ]);
    expect(res.ok).toBe(false);
  });

  it('refuses 500 contacts ops without a yield point and oversized batches', async () => {
    const fake = new FakeDeviceProviders({ maxBatchBytes: 500_000 });
    const port = fake.port(ME, CONTACTS_AUTHORITY);
    const ops: ProviderOp[] = Array.from({ length: 500 }, () => ({ op: 'insert', table: 'raw_contacts', values: {} }) as ProviderOp);
    expect(await port.applyBatch(ops)).toMatchObject({ ok: false, reason: 'provider' });
    ops[250] = { ...ops[250], yieldAllowed: true };
    expect((await port.applyBatch(ops)).ok).toBe(true);
    const big = await port.applyBatch([{ op: 'insert', table: 'raw_contacts', values: { [RawContacts.SYNC2]: 'x'.repeat(300_000) } }]);
    expect(big).toMatchObject({ ok: false, reason: 'tooLarge' });
  });

  it('normalises names and addresses like ContactsProvider', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId } = await contactWithEmail(fake);
    const res = await port.applyBatch([
      { op: 'insert', table: 'data', values: { [Data.RAW_CONTACT_ID]: rawId, [Data.MIMETYPE]: MimeType.STRUCTURED_NAME, [StructuredName.DISPLAY_NAME]: 'Ada Lovelace' } },
      { op: 'insert', table: 'data', values: { [Data.RAW_CONTACT_ID]: rawId, [Data.MIMETYPE]: MimeType.STRUCTURED_POSTAL, [StructuredPostal.CITY]: 'London', [StructuredPostal.COUNTRY]: 'UK' } },
    ]);
    if (!res.ok) throw new Error(res.message);
    expect(fake.row('data', res.results[0].id!)).toMatchObject({ [StructuredName.GIVEN_NAME]: 'Ada', [StructuredName.FAMILY_NAME]: 'Lovelace' });
    expect(fake.row('data', res.results[1].id!)![StructuredPostal.FORMATTED_ADDRESS]).toBe('London, UK');
  });

  it('stores a photo written as a blob and serves it to readPhoto', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId } = await contactWithEmail(fake);
    const res = await port.applyBatch([
      { op: 'insert', table: 'data', values: { [Data.RAW_CONTACT_ID]: rawId, [Data.MIMETYPE]: MimeType.PHOTO, [Data.DATA15]: { b64: 'AAAA' } } },
    ]);
    expect(res.ok).toBe(true);
    const photo = await port.readPhoto(rawId, 512);
    expect(photo?.jpegBase64).toBe('AAAA');
    expect(photo?.fileId).toEqual(expect.any(Number));
    const rows = await port.query({ table: 'data', columns: [Data.DATA14, Data.DATA15], where: `${Data.MIMETYPE} = ?`, args: [MimeType.PHOTO] });
    // data14 is a TEXT column: the file id reads back as text.
    expect(rows.rows[0]).toEqual([String(photo!.fileId), null]);
  });

  it('keeps a photo within the 96 px thumbnail as the thumbnail alone, and serves that to readPhoto', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId } = await contactWithEmail(fake);
    const res = await port.applyBatch([
      { op: 'insert', table: 'data', values: { [Data.RAW_CONTACT_ID]: rawId, [Data.MIMETYPE]: MimeType.PHOTO, [Data.DATA15]: { b64: JPEG } } },
    ]);
    expect(res.ok).toBe(true);
    const rows = await port.query({ table: 'data', columns: [Data.DATA14, Data.DATA15], where: `${Data.MIMETYPE} = ?`, args: [MimeType.PHOTO] });
    // No PHOTO_FILE_ID for a 1×1 JPEG, and the thumbnail does not read back.
    expect(rows.rows[0]).toEqual([null, null]);
    expect(await port.readPhoto(rawId, 512)).toEqual({ jpegBase64: JPEG, fileId: null });
  });

  it('weighs a batch as its Binder transaction does: two bytes per character of its JSON, a photo by its bytes', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId } = await contactWithEmail(fake);
    // 600,000 characters of text are about 1.2 MB in the Parcel; the same number of base64 characters are 450 KB of photo.
    const text = await port.applyBatch([{ op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.SYNC2]: 'x'.repeat(600_000) } }]);
    expect(text).toMatchObject({ ok: false, reason: 'tooLarge' });
    const photo = await port.applyBatch([
      { op: 'insert', table: 'data', values: { [Data.RAW_CONTACT_ID]: rawId, [Data.MIMETYPE]: MimeType.PHOTO, [Data.DATA15]: { b64: 'A'.repeat(600_000) } } },
    ]);
    expect(photo.ok).toBe(true);
  });

  it('models Fossify saves: rows re-inserted without DATA_SYNC', async () => {
    const fake = new FakeDeviceProviders();
    const { rawId, dataId } = await contactWithEmail(fake);
    fake.user.fossifySave(rawId, null, [{ [Data.MIMETYPE]: MimeType.EMAIL, [Data.DATA1]: 'a@example.org' }]);
    expect(fake.row('data', dataId)).toBeUndefined();
    const emails = fake.rows('data', `${Data.RAW_CONTACT_ID} = ?`, [rawId]);
    expect(emails).toHaveLength(1);
    expect(emails[0][Data.DATA_SYNC1]).toBeNull();
    expect(fake.row('raw_contacts', rawId)![RawContacts.DIRTY]).toBe(1);
  });
});

describe('FakeDeviceProviders: calendar', () => {
  async function calendar(fake: FakeDeviceProviders) {
    const port = fake.port(ME, CALENDAR_AUTHORITY);
    const res = await port.applyBatch([
      {
        op: 'insert',
        table: 'calendars',
        values: {
          [Calendars._SYNC_ID]: 'c/b',
          [Calendars.NAME]: 'Personal',
          [Calendars.CALENDAR_DISPLAY_NAME]: 'Personal',
          [Calendars.CALENDAR_COLOR]: -16776961,
          [Calendars.CALENDAR_ACCESS_LEVEL]: 700,
          [Calendars.OWNER_ACCOUNT]: ME,
          [Calendars.SYNC_EVENTS]: 1,
        },
      },
    ]);
    if (!res.ok) throw new Error(res.message);
    return { port, calendarId: res.results[0].id! };
  }

  it('requires the calendar columns the provider requires', async () => {
    const fake = new FakeDeviceProviders();
    const port = fake.port(ME, CALENDAR_AUTHORITY);
    const res = await port.applyBatch([{ op: 'insert', table: 'calendars', values: { [Calendars.NAME]: 'x' } }]);
    expect(res).toMatchObject({ ok: false, reason: 'provider' });
  });

  it('enforces recurring/exception column rules, all-day fixes and the NULL-status crash', async () => {
    const fake = new FakeDeviceProviders();
    const { port, calendarId } = await calendar(fake);
    const base = { [Events.CALENDAR_ID]: calendarId, [Events.EVENT_TIMEZONE]: 'UTC', [Events.STATUS]: 1 };
    const master = await port.applyBatch([
      { op: 'insert', table: 'events', values: { ...base, [Events._SYNC_ID]: 'c/e1', [Events.DTSTART]: 1_000, [Events.DTEND]: 5_000, [Events.RRULE]: 'FREQ=DAILY', [Events.DURATION]: 'P3600S' } },
    ]);
    if (!master.ok) throw new Error(master.message);
    const m = fake.row('events', master.results[0].id!)!;
    expect(m[Events.DTEND]).toBeNull();
    expect(m[Events.ORGANIZER]).toBe(ME);
    expect(await port.applyBatch([{ op: 'insert', table: 'events', values: { ...base, [Events.DTSTART]: 0, [Events.RRULE]: 'FREQ=DAILY' } }])).toMatchObject({ ok: false });
    expect(await port.applyBatch([{ op: 'insert', table: 'events', values: { ...base, [Events.DTSTART]: 0, [Events.RRULE]: 'FREQ=YEARLY;RSCALE=CHINESE', [Events.DURATION]: 'P1D' } }])).toMatchObject({ ok: false });
    expect(await port.applyBatch([{ op: 'insert', table: 'events', values: { ...base, [Events.ALL_DAY]: 1, [Events.DTSTART]: 0, [Events.RRULE]: 'FREQ=DAILY', [Events.DURATION]: 'PT0S' } }])).toMatchObject({ ok: false });
    const allDay = await port.applyBatch([
      { op: 'insert', table: 'events', values: { ...base, [Events.ALL_DAY]: 1, [Events.DTSTART]: 86_400_000 + 3_600_000, [Events.RRULE]: 'FREQ=DAILY', [Events.DURATION]: 'P86400S' } },
    ]);
    if (!allDay.ok) throw new Error(allDay.message);
    expect(fake.row('events', allDay.results[0].id!)).toMatchObject({ [Events.DTSTART]: 86_400_000, [Events.DURATION]: 'P1D' });
    expect(await port.applyBatch([{ op: 'update', table: 'events', id: master.results[0].id!, values: { [Events.STATUS]: null } }])).toMatchObject({ ok: false });
    expect(await port.applyBatch([{ op: 'update', table: 'events', id: master.results[0].id!, values: { [Events.SELF_ATTENDEE_STATUS]: 1 } }])).toMatchObject({ ok: false });
  });

  it('links exceptions to their master and keeps them when a sync adapter deletes the master', async () => {
    const fake = new FakeDeviceProviders();
    const { port, calendarId } = await calendar(fake);
    const res = await port.applyBatch([
      { op: 'insert', table: 'events', values: { [Events.CALENDAR_ID]: calendarId, [Events._SYNC_ID]: 'c/e1', [Events.DTSTART]: 0, [Events.RRULE]: 'FREQ=DAILY', [Events.DURATION]: 'P3600S', [Events.EVENT_TIMEZONE]: 'UTC', [Events.STATUS]: 1 } },
      { op: 'insert', table: 'events', values: { [Events.CALENDAR_ID]: calendarId, [Events.ORIGINAL_SYNC_ID]: 'c/e1', [Events.ORIGINAL_INSTANCE_TIME]: 86_400_000, [Events.DTSTART]: 86_400_000, [Events.DTEND]: 90_000_000, [Events.EVENT_TIMEZONE]: 'UTC', [Events.STATUS]: 1 } },
    ]);
    if (!res.ok) throw new Error(res.message);
    const [masterId, exceptionId] = res.results.map((r) => r.id!);
    expect(fake.row('events', exceptionId)![Events.ORIGINAL_ID]).toBe(masterId);
    await port.applyBatch([{ op: 'update', table: 'events', id: masterId, values: { [Events._SYNC_ID]: 'c/e9' } }]);
    expect(fake.row('events', exceptionId)![Events.ORIGINAL_SYNC_ID]).toBe('c/e9');
    await port.applyBatch([{ op: 'delete', table: 'events', id: masterId }]);
    expect(fake.row('events', exceptionId)).toBeDefined();
  });

  it('leaves STATUS NULL on an event an app inserts without one (the column has no default)', async () => {
    const fake = new FakeDeviceProviders();
    const { calendarId } = await calendar(fake);
    const id = fake.user.insertEvent(calendarId, { [Events.DTSTART]: 0, [Events.DTEND]: 1000, [Events.EVENT_TIMEZONE]: 'UTC', [Events.TITLE]: 'x' });
    expect(fake.row('events', id)![Events.STATUS]).toBeNull();
    // Unlike AVAILABILITY and ACCESS_LEVEL (NOT NULL DEFAULT 0).
    expect(fake.row('events', id)).toMatchObject({ [Events.AVAILABILITY]: 0, [Events.ACCESS_LEVEL]: 0 });
  });

  it('hard-deletes app-deleted events without _SYNC_ID and soft-deletes synced ones', async () => {
    const fake = new FakeDeviceProviders();
    const { calendarId } = await calendar(fake);
    const local = fake.user.insertEvent(calendarId, { [Events.DTSTART]: 0, [Events.DTEND]: 1000, [Events.EVENT_TIMEZONE]: 'UTC', [Events.TITLE]: 'x', [Events.STATUS]: 1 });
    expect(fake.row('events', local)).toMatchObject({ [Events.DIRTY]: 1, [Events.MUTATORS]: expect.any(String) });
    fake.user.deleteEvent(local);
    expect(fake.row('events', local)).toBeUndefined();
    const synced = fake.user.insertEvent(calendarId, { [Events.DTSTART]: 0, [Events.DTEND]: 1000, [Events.EVENT_TIMEZONE]: 'UTC', [Events._SYNC_ID]: '~pending/u1', [Events.STATUS]: 1 }, { reminders: [{ minutes: 10, method: 1 }] });
    fake.user.deleteEvent(synced);
    expect(fake.row('events', synced)).toMatchObject({ [Events.DELETED]: 1, [Events.DIRTY]: 1 });
    expect(fake.rows('reminders', 'event_id = ?', [synced])).toHaveLength(0);
  });

  it('models CONTENT_EXCEPTION_URI: only the exception is dirty; a split clones _SYNC_ID', async () => {
    const fake = new FakeDeviceProviders();
    const { port, calendarId } = await calendar(fake);
    const res = await port.applyBatch([
      { op: 'insert', table: 'events', values: { [Events.CALENDAR_ID]: calendarId, [Events._SYNC_ID]: 'c/e1', [Events.UID_2445]: 'u1', [Events.DTSTART]: 0, [Events.RRULE]: 'FREQ=DAILY', [Events.DURATION]: 'P3600S', [Events.EVENT_TIMEZONE]: 'UTC', [Events.STATUS]: 1 } },
      { op: 'insert', table: 'attendees', values: { [Attendees.ATTENDEE_EMAIL]: ME, [Attendees.ATTENDEE_STATUS]: 3 }, refs: { event_id: 0 } },
    ]);
    if (!res.ok) throw new Error(res.message);
    const masterId = res.results[0].id!;
    const ex = fake.user.exceptionViaUri(masterId, 86_400_000, { [Events.SELF_ATTENDEE_STATUS]: 1 });
    expect(fake.row('events', masterId)![Events.DIRTY]).toBeNull();
    expect(fake.row('events', ex)).toMatchObject({ [Events.DIRTY]: 1, [Events._SYNC_ID]: null, [Events.UID_2445]: 'u1', [Events.ORIGINAL_SYNC_ID]: 'c/e1' });
    expect(fake.rows('attendees', 'event_id = ?', [ex])[0][Attendees.ATTENDEE_STATUS]).toBe(1);
    const split = fake.user.splitViaUri(masterId, 5 * 86_400_000, '20260101T000000Z', {});
    expect(fake.row('events', split)![Events._SYNC_ID]).toBe('c/e1');
    expect(fake.row('events', masterId)![Events.RRULE]).toContain('UNTIL=20260101T000000Z');
    expect(fake.row('events', masterId)![Events.DIRTY]).toBeNull();
  });
});

describe('AOSP format checks', () => {
  it('accepts the Duration forms calendarcommon2 parses', () => {
    for (const ok of ['P1D', 'PT1H30M', 'P1DT2H', 'P2W', 'P1W2D', '-PT15M', 'P3600S', 'P0DT1H30M0S']) expect(aospDurationValid(ok)).toBe(true);
    for (const bad of ['1D', 'P1Y', 'PT1.5S', 'P', '']) expect(aospDurationValid(bad)).toBe(false);
  });

  it('rejects RRULE parts EventRecurrence does not know', () => {
    expect(aospRruleValid('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;WKST=SU;X-FOO=1')).toBe(true);
    expect(aospRruleValid('RRULE:FREQ=DAILY')).toBe(false);
    expect(aospRruleValid('FREQ=YEARLY;RSCALE=GREGORIAN;SKIP=OMIT')).toBe(false);
    expect(aospRruleValid('COUNT=2')).toBe(false);
  });
});

describe('FakeDeviceProviders: the native bridge rules', () => {
  async function calendarWithEvent(fake: FakeDeviceProviders, account = ME) {
    const port = fake.port(account, CALENDAR_AUTHORITY);
    const res = await port.applyBatch([
      {
        op: 'insert',
        table: 'calendars',
        values: {
          [Calendars.NAME]: 'Personal',
          [Calendars.CALENDAR_DISPLAY_NAME]: 'Personal',
          [Calendars.CALENDAR_COLOR]: -16776961,
          [Calendars.CALENDAR_ACCESS_LEVEL]: 700,
          [Calendars.OWNER_ACCOUNT]: account,
        },
      },
      {
        op: 'insert',
        table: 'events',
        values: { [Events.DTSTART]: 0, [Events.DTEND]: 3_600_000, [Events.EVENT_TIMEZONE]: 'UTC', [Events.STATUS]: 1 },
        refs: { [Events.CALENDAR_ID]: 0 },
      },
      { op: 'insert', table: 'attendees', values: { [Attendees.ATTENDEE_EMAIL]: OTHER }, refs: { event_id: 1 } },
      { op: 'insert', table: 'extended_properties', values: { name: 'x', value: '1' }, refs: { event_id: 1 } },
    ]);
    if (!res.ok) throw new Error(res.message);
    return {
      port,
      calendarId: res.results[0].id!,
      eventId: res.results[1].id!,
      attendeeId: res.results[2].id!,
      propertyId: res.results[3].id!,
    };
  }

  it('stores numbers written to data1..data14 as text', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId } = await contactWithEmail(fake);
    const res = await port.applyBatch([
      {
        op: 'insert',
        table: 'data',
        values: { [Data.RAW_CONTACT_ID]: rawId, [Data.MIMETYPE]: MimeType.PHONE, [Data.DATA1]: '+1 555', [Data.DATA2]: 2 },
      },
    ]);
    if (!res.ok) throw new Error(res.message);
    const rows = await port.query({
      table: 'data',
      columns: [Data.DATA2, Data.RAW_CONTACT_ID],
      where: `${Data.MIMETYPE} = ?`,
      args: [MimeType.PHONE],
    });
    expect(rows.rows).toEqual([['2', rawId]]);
    // Asserts compare as text, so a number still matches.
    const ok = await port.applyBatch([{ op: 'assert', table: 'data', id: res.results[0].id!, values: { [Data.DATA2]: 2 } }]);
    expect(ok.ok).toBe(true);
  });

  it('leaves DIRTY NULL on events and calendars the sync adapter inserts', async () => {
    const fake = new FakeDeviceProviders();
    const { port, calendarId, eventId } = await calendarWithEvent(fake);
    expect(fake.row('calendars', calendarId)![Calendars.DIRTY]).toBeNull();
    expect(fake.row('events', eventId)![Events.DIRTY]).toBeNull();
    expect((await port.query({ table: 'events', columns: ['_id'], where: 'dirty = 0' })).rows).toEqual([]);
    expect((await port.query({ table: 'events', columns: ['_id'], where: 'dirty = 1' })).rows).toEqual([]);
  });

  it('expects exactly the id row unless told otherwise, and applies where to it', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId } = await contactWithEmail(fake);
    const gone = await port.applyBatch([{ op: 'delete', table: 'raw_contacts', id: rawId + 1000 }]);
    expect(gone).toMatchObject({ ok: false, reason: 'assert' });
    const tolerated = await port.applyBatch([{ op: 'delete', table: 'raw_contacts', id: rawId + 1000, expectCount: 0 }]);
    expect(tolerated).toEqual({ ok: true, results: [{ count: 0 }] });
    const mismatch = await port.applyBatch([
      { op: 'update', table: 'raw_contacts', id: rawId, where: `${RawContacts.DIRTY} = 1`, values: { [RawContacts.SYNC1]: 'x' } },
    ]);
    expect(mismatch).toMatchObject({ ok: false, reason: 'assert' });
    const matched = await port.applyBatch([
      { op: 'update', table: 'raw_contacts', id: rawId, where: `${RawContacts.DIRTY} = 0`, values: { [RawContacts.SYNC1]: 'x' } },
    ]);
    expect(matched).toEqual({ ok: true, results: [{ count: 1 }] });
  });

  it('refuses _id in where on calendar child tables, and updates extended properties by id only', async () => {
    const fake = new FakeDeviceProviders();
    const { port, eventId, attendeeId, propertyId } = await calendarWithEvent(fake);
    await expect(
      port.query({ table: 'attendees', columns: ['event_id'], where: '_id = ?', args: [attendeeId] }),
    ).rejects.toMatchObject({ code: 'provider' });
    const byWhere = await port.applyBatch([{ op: 'delete', table: 'attendees', where: '_id = ?', args: [attendeeId] }]);
    expect(byWhere).toMatchObject({ ok: false, reason: 'provider' });
    const byId = await port.applyBatch([{ op: 'delete', table: 'attendees', id: attendeeId }]);
    expect(byId).toEqual({ ok: true, results: [{ count: 1 }] });
    const propertiesByWhere = await port.applyBatch([
      { op: 'update', table: 'extended_properties', where: 'event_id = ?', args: [eventId], values: { value: '2' } },
    ]);
    expect(propertiesByWhere).toMatchObject({ ok: false, reason: 'provider' });
    const propertiesById = await port.applyBatch([
      { op: 'update', table: 'extended_properties', id: propertyId, values: { value: '2' } },
    ]);
    expect(propertiesById.ok).toBe(true);
  });

  it('fails with assert for a parent that is gone and with scope for one of another account', async () => {
    const fake = new FakeDeviceProviders();
    const mine = await calendarWithEvent(fake);
    const theirs = await calendarWithEvent(fake, OTHER);
    const gone = await mine.port.applyBatch([
      { op: 'insert', table: 'reminders', values: { event_id: theirs.eventId + 1000, minutes: 10 } },
    ]);
    expect(gone).toMatchObject({ ok: false, reason: 'assert' });
    const foreign = await mine.port.applyBatch([
      { op: 'insert', table: 'reminders', values: { event_id: theirs.eventId, minutes: 10 } },
    ]);
    expect(foreign).toMatchObject({ ok: false, reason: 'scope' });
    const unnamed = await mine.port.applyBatch([{ op: 'insert', table: 'reminders', values: { minutes: 10 } }]);
    expect(unnamed).toMatchObject({ ok: false, reason: 'scope' });
    const moveAway = await mine.port.applyBatch([
      { op: 'update', table: 'events', id: mine.eventId, values: { [Events.CALENDAR_ID]: theirs.calendarId } },
    ]);
    expect(moveAway).toMatchObject({ ok: false, reason: 'scope' });
    const wrongRef = await mine.port.applyBatch([
      { op: 'insert', table: 'colors', values: { color_type: 0, color_index: '1', color: 1 } },
      { op: 'insert', table: 'reminders', values: { minutes: 10 }, refs: { event_id: 0 } },
    ]);
    expect(wrongRef).toMatchObject({ ok: false, reason: 'scope' });
    const leaves = await mine.port.applyBatch([
      { op: 'update', table: 'calendars', id: mine.calendarId, values: { [Calendars.ACCOUNT_NAME]: OTHER } },
    ]);
    expect(leaves).toMatchObject({ ok: false, reason: 'scope' });
  });

  it('wants syncState last and never at a yield point', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId } = await contactWithEmail(fake);
    const early = await port.applyBatch([
      { op: 'syncState', value: '{}' },
      { op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.SYNC1]: 'x' } },
    ]);
    expect(early).toMatchObject({ ok: false, reason: 'scope' });
    const yielding = await port.applyBatch([
      { op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.SYNC1]: 'x' } },
      { op: 'syncState', value: '{}', yieldAllowed: true },
    ]);
    expect(yielding).toMatchObject({ ok: false, reason: 'scope' });
    expect(fake.readSyncState(ME, CONTACTS_AUTHORITY)).toBeNull();
  });

  it('takes raw_contact_is_read_only on writes but refuses it in projections and selections', async () => {
    const fake = new FakeDeviceProviders();
    const port = fake.port(ME, CONTACTS_AUTHORITY);
    const res = await port.applyBatch([{ op: 'insert', table: 'raw_contacts', values: { [RawContacts.RAW_CONTACT_IS_READ_ONLY]: 1 } }]);
    expect(res.ok).toBe(true);
    await expect(port.query({ table: 'raw_contacts', columns: [RawContacts.RAW_CONTACT_IS_READ_ONLY] })).rejects.toMatchObject({
      code: 'provider',
    });
    await expect(
      port.query({ table: 'raw_contacts', columns: [RawContacts._ID], where: `${RawContacts.RAW_CONTACT_IS_READ_ONLY} = 1` }),
    ).rejects.toMatchObject({ code: 'provider' });
  });

  it('returns no id for a settings insert, which cannot be addressed by id either', async () => {
    const fake = new FakeDeviceProviders();
    const port = fake.port(ME, CONTACTS_AUTHORITY);
    const res = await port.applyBatch([{ op: 'insert', table: 'settings', values: { ungrouped_visible: 1 } }]);
    expect(res).toEqual({ ok: true, results: [{}] });
    const byId = await port.applyBatch([{ op: 'delete', table: 'settings', id: 1 }]);
    expect(byId).toMatchObject({ ok: false, reason: 'provider' });
  });

  it('counts the op at a yield point before resetting, like ContactsProvider', async () => {
    const fake = new FakeDeviceProviders();
    const { port, rawId } = await contactWithEmail(fake);
    const update = (yieldAllowed = false): ProviderOp => ({
      op: 'update',
      table: 'raw_contacts',
      id: rawId,
      values: { [RawContacts.SYNC2]: 'y' },
      yieldAllowed,
    });
    // 499 ops, then a yield point: fine.
    const fits = [...Array.from({ length: 498 }, () => update()), update(true), ...Array.from({ length: 10 }, () => update())];
    expect((await port.applyBatch(fits)).ok).toBe(true);
    // The yield point is the 500th op since the start: refused.
    const late = [...Array.from({ length: 499 }, () => update()), update(true)];
    expect(await port.applyBatch(late)).toMatchObject({ ok: false, reason: 'provider' });
  });
});
