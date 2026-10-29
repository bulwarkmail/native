import { describe, expect, it } from 'vitest';
import { Data, MimeType, RawContacts } from '../../android-columns';
import { sha256Hex } from '../../../lib/sha256';
import { base64ToBytes } from '../../contacts/photo';
import type { Row } from '../../types';
import { appleCard, googleCard, JPEG, probeCard } from './fixtures';
import { Harness, JMAP } from './harness';

/** Cells as text, so the fixtures don't depend on how the provider types a column. */
function cells(row: Row | undefined, columns: string[]): Record<string, string | null> {
  if (!row) throw new Error('missing row');
  return Object.fromEntries(columns.map((c) => [c, row[c] === null || row[c] === undefined ? null : String(row[c])]));
}

const NAME = ['data1', 'data2', 'data3', 'data4', 'data5', 'data6', 'data7', 'data8', 'data9'];
const TYPED = ['data1', 'data2', 'data3'];
const PRIMARY = ['data1', 'data2', 'data3', 'is_primary'];
const POSTAL = ['data1', 'data2', 'data3', 'data4', 'data5', 'data6', 'data7', 'data8', 'data9', 'data10'];
const ORG = ['data1', 'data4', 'data5', 'data6'];

const photoHash = (b64: string) => `sha256:${sha256Hex(base64ToBytes(b64)!)}`;

describe('contacts download: golden rows', () => {
  it('writes the probe card as one row per entry with its keys', async () => {
    const h = new Harness();
    h.names.set('urn:uuid:other-person', 'Other Person');
    const { id, rawId } = await h.seed(probeCard());
    const rows = h.rowsByKey(rawId);
    expect(Object.keys(rows).sort()).toEqual([
      'addresses:home', 'anniversaries:bday', 'anniversaries:wed', 'emails:work1', 'emails:x/y', 'emails:zz9',
      'links:l1', 'media:ph', 'name', 'nicknames:nk', 'notes:n1', 'organizations:o1|titles:t1,r1', 'phones:fax7',
      'phones:p-a', 'relatedTo:urn:uuid:other-person',
    ]);
    expect(cells(rows.name, NAME)).toEqual({
      data1: 'Dr. Probe Person', data2: 'Probe', data3: 'Person', data4: 'Dr.', data5: null, data6: null,
      data7: 'Proob', data8: null, data9: null,
    });
    expect(cells(rows['nicknames:nk'], ['data1', 'data2'])).toEqual({ data1: 'Probby', data2: '1' });
    expect(cells(rows['emails:work1'], PRIMARY)).toEqual({ data1: 'probe@work.example', data2: '0', data3: 'Office', is_primary: '1' });
    expect(cells(rows['emails:x/y'], PRIMARY)).toEqual({ data1: 'slash@example.org', data2: '3', data3: null, is_primary: '0' });
    expect(cells(rows['emails:zz9'], PRIMARY)).toEqual({ data1: 'private@example.org', data2: '1', data3: null, is_primary: '0' });
    expect(cells(rows['phones:p-a'], TYPED)).toEqual({ data1: '+49 30 1234', data2: '2', data3: null });
    expect(cells(rows['phones:fax7'], TYPED)).toEqual({ data1: '+49 30 9999', data2: '4', data3: null });
    expect(cells(rows['addresses:home'], POSTAL)).toEqual({
      data1: 'Main St 12, 10115 Berlin, Germany', data2: '1', data3: null, data4: 'Main St 12 4b', data5: null,
      data6: null, data7: 'Berlin', data8: null, data9: '10115', data10: 'Germany',
    });
    expect(cells(rows['organizations:o1|titles:t1,r1'], ORG)).toEqual({ data1: 'ACME', data4: 'Chief Prober', data5: 'R&D', data6: 'Lead' });
    expect(cells(rows['links:l1'], TYPED)).toEqual({ data1: 'https://probe.example', data2: '5', data3: null });
    expect(cells(rows['anniversaries:bday'], TYPED)).toEqual({ data1: '--03-14', data2: '3', data3: null });
    expect(cells(rows['anniversaries:wed'], TYPED)).toEqual({ data1: '2010-06-01', data2: '1', data3: null });
    expect(cells(rows['relatedTo:urn:uuid:other-person'], TYPED)).toEqual({ data1: 'Other Person', data2: '6', data3: null });
    expect(cells(rows['notes:n1'], ['data1'])).toEqual({ data1: 'first note' });
    expect(rows['media:ph'].data_sync2).toBe(photoHash(JPEG));
    // A 1×1 photo is kept as the thumbnail alone (no PHOTO_FILE_ID), and read from it.
    expect(rows['media:ph'].data14).toBeNull();
    expect((await h.port.readPhoto(rawId, 512))?.jpegBase64).toBe(JPEG);

    const raw = h.rawContact(rawId);
    expect(raw).toMatchObject({
      [RawContacts.SOURCE_ID]: `${JMAP}/${id}`,
      [RawContacts.SYNC1]: `${JMAP}/${h.book}`,
      [RawContacts.SYNC3]: null,
      [RawContacts.DIRTY]: 0,
    });
    expect(Number(raw[RawContacts.RAW_CONTACT_IS_READ_ONLY])).toBe(0);
  });

  it('keeps the photo out of the shadow: its data URI becomes the hash of its bytes', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(probeCard());
    const shadow = JSON.parse(h.rawContact(rawId)[RawContacts.SYNC2] as string);
    expect(shadow.media.ph.uri).toBe(photoHash(JPEG));
    expect({ ...shadow, media: undefined, '~memberOf': undefined }).toEqual({ ...h.card(id), media: undefined });
  });

  it('records each row as stored, so a clean contact needs no baseline heal', async () => {
    const h = new Harness();
    for (const card of [probeCard(), appleCard(), googleCard(), { name: { full: 'Madonna' } }]) {
      const { rawId } = await h.seed(card);
      const local = await h.contact(rawId);
      expect(h.planner.planBaselineHeal(local)).toBeNull();
      for (const row of local.rows) if (row.mimetype !== MimeType.PHOTO) expect(row.baseline).not.toBeNull();
    }
  });

  it('maps an Apple card with positional keys, filling the formatted address itself', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(appleCard());
    const rows = h.rowsByKey(rawId);
    expect(cells(rows['emails:k1'], PRIMARY)).toEqual({ data1: 'anna@example.com', data2: '1', data3: null, is_primary: '1' });
    expect(cells(rows['emails:k2'], PRIMARY)).toEqual({ data1: 'anna@work.example', data2: '2', data3: null, is_primary: '0' });
    expect(cells(rows['phones:k1'], TYPED)).toMatchObject({ data2: '2' });
    expect(cells(rows['phones:k2'], TYPED)).toMatchObject({ data2: '3' });
    expect(cells(rows['phones:k3'], TYPED)).toMatchObject({ data2: '4' });
    expect(cells(rows['addresses:k1'], POSTAL)).toEqual({
      data1: '1 Infinite Loop, 95014 Cupertino, CA, USA', data2: '2', data3: null, data4: '1 Infinite Loop', data5: null,
      data6: null, data7: 'Cupertino', data8: 'CA', data9: '95014', data10: 'USA',
    });
    expect(cells(rows['anniversaries:k1'], TYPED)).toEqual({ data1: '1980-05-04', data2: '3', data3: null });
    expect(Object.keys(rows).some((k) => k.startsWith('onlineServices'))).toBe(false);
  });

  it('maps a Google card: custom display name, legacy cell phone, profile link, department list, relation by name', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(googleCard());
    const rows = h.rowsByKey(rawId);
    expect(cells(rows.name, NAME)).toEqual({
      data1: 'Groß, Günther', data2: 'Günther', data3: 'Groß', data4: 'Prof.', data5: 'Karl', data6: 'PhD',
      data7: null, data8: null, data9: null,
    });
    expect(cells(rows['nicknames:k1'], ['data1'])).toEqual({ data1: 'Gü' });
    expect(cells(rows['nicknames:k2'], ['data1'])).toEqual({ data1: 'GKG' });
    expect(cells(rows['phones:k1'], TYPED)).toEqual({ data1: '0171 2345678', data2: '2', data3: null });
    // The label names a type Android has.
    expect(cells(rows['links:k1'], TYPED)).toEqual({ data1: 'https://example.org/~guenther', data2: '3', data3: null });
    expect(cells(rows['organizations:k1|titles:k1,'], ORG)).toEqual({ data1: 'Uni Beispiel', data4: 'Professor', data5: 'Informatik, AG Sync', data6: null });
    expect(cells(rows['relatedTo:Maria Groß'], TYPED)).toEqual({ data1: 'Maria Groß', data2: '14', data3: null });
    expect(cells(rows['anniversaries:k1'], TYPED)).toEqual({ data1: '--08-15', data2: '1', data3: null });
  });

  it('writes a name with only `full` as the display name and lets the provider split it', async () => {
    const h = new Harness();
    const { rawId } = await h.seed({ name: { full: 'Madonna' } });
    expect(cells(h.rowsByKey(rawId).name, ['data1', 'data2', 'data3'])).toEqual({ data1: 'Madonna', data2: 'Madonna', data3: null });
  });

  it('writes text longer than the provider keeps already cut, and never uploads the cut column', async () => {
    const h = new Harness();
    const long = 'x'.repeat(12_000);
    const { id, rawId } = await h.seed({ name: { full: 'Long Note' }, notes: { n1: { note: long } }, phones: { p1: { number: '1'.repeat(1200) } } });
    const rows = h.rowsByKey(rawId);
    expect((rows['notes:n1'].data1 as string).length).toBe(10 * 1024);
    expect((rows['phones:p1'].data1 as string).length).toBe(1000);
    expect(h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx).effect).toBe('none');
    h.device.user.updateData(rows['notes:n1']._id as number, { data1: `${rows['notes:n1'].data1 as string}!` });
    expect(h.planner.planUpload(await h.contact(rawId), h.ctx).kind).toBe('clean');
  });

  it('marks a card of read-only books read-only', async () => {
    const h = new Harness();
    h.readOnlyBooks.add(h.book);
    const { rawId } = await h.seed(appleCard());
    expect(Number(h.rawContact(rawId)[RawContacts.RAW_CONTACT_IS_READ_ONLY])).toBe(1);
  });
});

describe('contacts download: echoes and updates', () => {
  it.each([['probe', probeCard], ['apple', appleCard], ['google', googleCard]])('writes nothing for an unchanged %s card', async (_n, make) => {
    const h = new Harness();
    const { id, rawId } = await h.seed(make());
    const plan = h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx);
    expect(plan).toMatchObject({ effect: 'none', writes: 0, conflicts: 0 });
    expect(plan.ops.ops).toEqual([]);
  });

  it('writes nothing when the shadow itself comes back (a re-plan after a group change)', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    const local = await h.contact(rawId);
    const plan = h.planner.planDownload(local.shadow!, local, h.ctx);
    expect(plan.effect).toBe('none');
  });

  it('rewrites only the row of the entry the server changed, behind VERSION and DIRTY', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(appleCard());
    h.server.serverUpdate('ContactCard', JMAP, id, { 'emails/k2/address': 'anna@new-work.example' });
    const local = await h.contact(rawId);
    const plan = h.planner.planDownload(h.card(id), local, h.ctx);
    const [assert, raw, ...data] = plan.ops.ops;
    expect(assert).toEqual({ op: 'assert', table: 'raw_contacts', id: rawId, values: { version: local.version, dirty: 0 }, expectCount: 1 });
    expect(raw).toMatchObject({ op: 'update', table: 'raw_contacts', values: { [RawContacts.SYNC2]: expect.any(String) } });
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ op: 'update', table: 'data', expectCount: 1, values: { data1: 'anna@new-work.example', data_sync1: 'emails:k2' } });
    await h.applyOk(plan.ops);
    expect(h.rowsByKey(rawId)['emails:k2'].data1).toBe('anna@new-work.example');
    expect(h.dirty(rawId)).toBe(false);
  });

  it('inserts entries the server added and deletes the ones it removed', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(appleCard());
    h.server.serverUpdate('ContactCard', JMAP, id, { 'phones/k3': null, 'links': { k1: { uri: 'https://anna.example' } } });
    await h.download(id);
    const rows = h.rowsByKey(rawId);
    expect(rows['phones:k3']).toBeUndefined();
    expect(cells(rows['links:k1'], TYPED)).toEqual({ data1: 'https://anna.example', data2: '7', data3: null });
    expect(h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx).effect).toBe('none');
  });

  it('follows keys Stalwart shifted (a CardDAV insert at the front) by content, with no rewrite of the rows', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(appleCard());
    const before = h.rowsByKey(rawId);
    h.server.serverUpdate('ContactCard', JMAP, id, {
      emails: {
        k1: { address: 'first@example.com' },
        k2: { address: 'anna@example.com', contexts: { private: true }, pref: 1 },
        k3: { address: 'anna@work.example', contexts: { work: true } },
      },
    });
    const plan = h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx);
    const data = plan.ops.ops.filter((o) => o.op !== 'assert' && o.op !== 'syncState' && o.table === 'data');
    expect(data).toHaveLength(3);
    const renames = data.filter((o) => o.op === 'update');
    for (const r of renames) expect(Object.keys((r as { values: object }).values).sort()).toEqual(['data_sync1', 'data_sync3']);
    await h.applyOk(plan.ops);
    const rows = h.rowsByKey(rawId);
    expect(rows['emails:k2']._id).toBe(before['emails:k1']._id);
    expect(rows['emails:k3']._id).toBe(before['emails:k2']._id);
    expect(rows['emails:k1'].data1).toBe('first@example.com');
  });

  it('fails as a whole when the user edits the contact between read and write', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(appleCard());
    h.server.serverUpdate('ContactCard', JMAP, id, { 'notes/k1/note': 'from the server' });
    const plan = h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx);
    const phone = h.rowsByKey(rawId)['phones:k1']._id as number;
    h.device.beforeNextBatch(() => h.device.user.updateData(phone, { [Data.DATA1]: '+1 555 0199' }));
    const res = await h.apply(plan.ops);
    expect(res).toMatchObject({ ok: false, reason: 'assert' });
    expect(h.rowsByKey(rawId)['notes:k1'].data1).toBe('Met at WWDC');
  });

  it('adopts its own create whose identity was never written, keeping the local rows', async () => {
    const h = new Harness();
    const rawId = h.device.user.insertContact('usera@example.org', [
      { [Data.MIMETYPE]: MimeType.STRUCTURED_NAME, [Data.DATA1]: 'New Person', [Data.DATA2]: 'New', [Data.DATA3]: 'Person' },
      { [Data.MIMETYPE]: MimeType.EMAIL, [Data.DATA1]: 'new@example.org', [Data.DATA2]: 1 },
    ]);
    const plan = await h.planUpload(rawId);
    if (plan.kind !== 'upload' || plan.actions[0].kind !== 'create') throw new Error(`expected a create, got ${plan.kind}`);
    const cardId = h.send(plan.actions)!;
    // The response was lost: the next download finds the card and the pending uid.
    const local = await h.contact(rawId);
    const adopt = h.planner.planDownload(h.card(cardId), local, h.ctx);
    expect(adopt.effect).toBe('update');
    expect(adopt.stillDirty).toBe(true);
    await h.applyOk(adopt.ops);
    const after = await h.contact(rawId);
    expect(after).toMatchObject({ sourceId: `${JMAP}/${cardId}`, pending: null, dirty: true });
    expect(h.planner.planUpload(after, h.ctx).kind).toBe('clean');
  });
});
