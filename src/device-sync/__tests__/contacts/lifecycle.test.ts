import { describe, expect, it } from 'vitest';
import { Data, MimeType } from '../../android-columns';
import { MAX_PHOTO_BASE64 } from '../../contacts/photo';
import type { LocalContact } from '../../planner';
import { JPEG, JPEG2, probeCard } from './fixtures';
import { Harness, JMAP } from './harness';

/** The engine's view after every write: a clean contact whose rows the server card describes. */
async function expectSettled(h: Harness, id: string, rawId: number): Promise<LocalContact> {
  const local = await h.contact(rawId);
  expect(local.dirty).toBe(false);
  expect(h.planner.planDownload(h.card(id), local, h.ctx).effect).toBe('none');
  expect(h.planner.planBaselineHeal(local)).toBeNull();
  return local;
}

describe('contacts lifecycle', () => {
  it('settles after device edits, an editor rewrite and server edits in turn', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(probeCard());
    let rows = h.rowsByKey(rawId);

    // Several fields at once in AOSP Contacts.
    h.device.user.updateData(rows.name._id as number, { data2: 'Probert', data1: 'Dr. Probert Person' });
    h.device.user.updateData(rows['emails:zz9']._id as number, { data1: 'home@example.org' });
    h.device.user.updateData(rows['addresses:home']._id as number, { data9: '10117' });
    h.device.user.insertData(rawId, { [Data.MIMETYPE]: MimeType.PHONE, data1: '+49 30 7777', data2: 3 });
    await h.upload(rawId);
    const card = h.card(id);
    expect(card.name).toMatchObject({ full: 'Dr. Probert Person' });
    expect(card.emails!.zz9.address).toBe('home@example.org');
    expect(card.addresses!.home.components).toContainEqual({ kind: 'postcode', value: '10117' });
    expect(Object.values(card.phones!).map((p) => p.number)).toContain('+49 30 7777');
    expect(card.onlineServices).toEqual(probeCard().onlineServices);
    expect(card.notes!.n2).toEqual({ note: 'second note' });
    await expectSettled(h, id, rawId);

    // Fossify rewrites everything but the name; nothing uploads, the rows come back whole.
    rows = h.rowsByKey(rawId);
    h.device.user.fossifySave(rawId, null, Object.values(rows)
      .filter((r) => r[Data.MIMETYPE] === MimeType.EMAIL || r[Data.MIMETYPE] === MimeType.PHONE)
      .map((r) => ({ [Data.MIMETYPE]: r[Data.MIMETYPE], data1: r.data1, data2: r.data2 })));
    expect((await h.upload(rawId)).kind).toBe('clean');
    await expectSettled(h, id, rawId);
    expect(h.rowsByKey(rawId)['organizations:o1|titles:t1,r1'].data5).toBe('R&D');

    // The server edits and removes things.
    h.server.serverUpdate('ContactCard', JMAP, id, { 'nicknames/nk/name': 'Probo', 'links/l1': null, 'addresses/home/components': [{ kind: 'locality', value: 'Hamburg' }] });
    await h.download(id);
    await expectSettled(h, id, rawId);
    rows = h.rowsByKey(rawId);
    expect(rows['nicknames:nk'].data1).toBe('Probo');
    expect(rows['links:l1']).toBeUndefined();
    expect(rows['addresses:home']).toMatchObject({ data7: 'Hamburg', data4: null });
  });

  it('follows Stalwart re-keying the whole card by position, without rewriting a row', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(probeCard());
    const before = h.rowsByKey(rawId);
    h.server.rekeyPositionally(JMAP, id, 'ContactCard');
    const plan = h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx);
    for (const op of plan.ops.ops) {
      if (op.op === 'update' && op.table === 'data') expect(Object.keys(op.values).every((c) => c.startsWith('data_sync'))).toBe(true);
      expect(op.op === 'insert' || op.op === 'delete').toBe(false);
    }
    await h.applyOk(plan.ops);
    const after = h.rowsByKey(rawId);
    expect(after['organizations:k1|titles:k1,k2']._id).toBe(before['organizations:o1|titles:t1,r1']._id);
    expect(after['emails:k2']._id).toBe(before['emails:x/y']._id);
    await expectSettled(h, id, rawId);

    // The next device edit patches the entry under its new key.
    h.device.user.updateData(after['emails:k2']._id as number, { data1: 'slash3@example.org' });
    const upload = h.planner.planUpload(await h.contact(rawId), h.ctx);
    expect(upload).toMatchObject({ kind: 'upload', actions: [{ patch: { 'emails/k2/address': 'slash3@example.org' } }] });
  });

  it('writes a blob-backed photo from the bytes the engine fetched, and nothing for its echo', async () => {
    const h = new Harness();
    h.blobs.set('B1', JPEG);
    const { id, rawId } = await h.seed({ name: { full: 'Blob Photo' }, media: { p: { kind: 'photo', blobId: 'B1', mediaType: 'image/jpeg' } } });
    expect((await h.port.readPhoto(rawId, 512))?.jpegBase64).toBe(JPEG);
    expect((await h.contact(rawId)).shadow?.media).toEqual({ p: { kind: 'photo', blobId: 'B1', mediaType: 'image/jpeg' } });
    await expectSettled(h, id, rawId);
  });

  it('keeps the photo row when the photo bytes could not be fetched, and never reads it as deleted', async () => {
    const h = new Harness();
    h.blobs.set('B1', JPEG);
    const { id, rawId } = await h.seed({ name: { full: 'Blob Photo' }, emails: { e1: { address: 'a@example.org' } }, media: { p: { kind: 'photo', blobId: 'B1' } } });
    const photoRow = h.rowsByKey(rawId)['media:p']._id;
    h.blobs.delete('B1');
    h.server.serverUpdate('ContactCard', JMAP, id, { 'emails/e1/address': 'b@example.org' });
    await h.download(id);
    expect(h.rowsByKey(rawId)['media:p']?._id).toBe(photoRow);
    h.device.user.updateData(h.rowsByKey(rawId)['emails:e1']._id as number, { data1: 'c@example.org' });
    expect(h.planner.planUpload(await h.contact(rawId), h.ctx)).toMatchObject({ kind: 'upload', actions: [{ patch: { 'emails/e1/address': 'c@example.org' } }] });
    const plan = h.planner.planUpload(await h.contact(rawId), h.ctx);
    expect(plan.kind === 'upload' && Object.keys((plan.actions[0] as { patch: object }).patch)).toEqual(['emails/e1/address']);
  });

  it('keeps a photo too large for a provider batch on the server only, and never reads it as deleted', async () => {
    const h = new Harness();
    // About 900 KB of JPEG: the fake provider refuses a batch over 1 MB, as Binder does.
    const big = 'A'.repeat(1_200_000);
    const { id, rawId } = await h.seed({
      name: { full: 'Big Photo' },
      emails: { e1: { address: 'a@example.org' } },
      media: { p: { kind: 'photo', uri: `data:image/jpeg;base64,${big}`, mediaType: 'image/jpeg' } },
    });
    // The contact is there, without the photo; its echo writes nothing.
    expect(Object.keys(h.rowsByKey(rawId)).sort()).toEqual(['emails:e1', 'name']);
    await expectSettled(h, id, rawId);

    h.device.user.updateData(h.rowsByKey(rawId)['emails:e1']._id as number, { data1: 'b@example.org' });
    expect(h.planner.planUpload(await h.contact(rawId), h.ctx)).toEqual({
      kind: 'upload', actions: [{ kind: 'update', id, patch: { 'emails/e1/address': 'b@example.org' } }],
    });
    await h.upload(rawId);
    expect(h.card(id).media).toEqual({ p: { kind: 'photo', uri: `data:image/jpeg;base64,${big}`, mediaType: 'image/jpeg' } });
    await expectSettled(h, id, rawId);

    // A photo set on the device replaces it.
    h.device.user.setPhoto(rawId, JPEG2);
    h.devicePhotos.set(rawId, JPEG2);
    expect(h.planner.planUpload(await h.contact(rawId), h.ctx)).toEqual({
      kind: 'upload', actions: [{ kind: 'update', id, patch: { 'media/p/uri': `data:image/jpeg;base64,${JPEG2}`, 'media/p/mediaType': 'image/jpeg' } }],
    });
    await h.upload(rawId);
    expect(h.device.photo(Number(h.rowsByKey(rawId)['media:p'].data14))).toBe(JPEG2);
    await expectSettled(h, id, rawId);
  });

  it('writes a photo up to the budget of a provider batch, and none beyond it', async () => {
    const h = new Harness();
    const seedPhoto = (b64: string) => h.seed({ name: { full: 'Sized' }, media: { p: { kind: 'photo', uri: `data:image/jpeg;base64,${b64}` } } });
    const fits = 'A'.repeat(MAX_PHOTO_BASE64);
    const within = await seedPhoto(fits);
    expect(h.device.photo(Number(h.rowsByKey(within.rawId)['media:p'].data14))).toBe(fits);
    await expectSettled(h, within.id, within.rawId);
    const beyond = await seedPhoto('A'.repeat(MAX_PHOTO_BASE64 + 4));
    expect(h.rowsByKey(beyond.rawId)['media:p']).toBeUndefined();
    await expectSettled(h, beyond.id, beyond.rawId);
  });

  it('never reads a photo whose bytes could not be fetched as deleted, and writes it once they can be', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed({
      name: { full: 'Blob Photo' },
      emails: { e1: { address: 'a@example.org' } },
      media: { p: { kind: 'photo', blobId: 'B1', mediaType: 'image/jpeg' } },
    });
    expect(h.rowsByKey(rawId)['media:p']).toBeUndefined();
    h.device.user.updateData(h.rowsByKey(rawId)['emails:e1']._id as number, { data1: 'b@example.org' });
    expect(h.planner.planUpload(await h.contact(rawId), h.ctx)).toEqual({
      kind: 'upload', actions: [{ kind: 'update', id, patch: { 'emails/e1/address': 'b@example.org' } }],
    });
    await h.upload(rawId);
    expect(h.card(id).media).toEqual({ p: { kind: 'photo', blobId: 'B1', mediaType: 'image/jpeg' } });

    // With the bytes at hand, the next write of the card brings the photo.
    h.blobs.set('B1', JPEG);
    h.server.serverUpdate('ContactCard', JMAP, id, { 'emails/e1/address': 'c@example.org' });
    await h.download(id);
    expect((await h.port.readPhoto(rawId, 512))?.jpegBase64).toBe(JPEG);
    await expectSettled(h, id, rawId);
  });

  it('does not read a server photo it could not write as deleted after merging it into an edited contact', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed({ name: { full: 'Merge Photo' }, emails: { e1: { address: 'a@example.org' } }, phones: { p1: { number: '1' } } });
    // The server adds a photo too large to write while the device edits the phone.
    h.device.user.updateData(h.rowsByKey(rawId)['phones:p1']._id as number, { data1: '2' });
    const big = 'A'.repeat(1_200_000);
    h.server.serverUpdate('ContactCard', JMAP, id, { media: { p: { kind: 'photo', uri: `data:image/jpeg;base64,${big}` } } });
    await h.applyOk(h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx).ops);
    expect(h.planner.planUpload(await h.contact(rawId), h.ctx)).toEqual({
      kind: 'upload', actions: [{ kind: 'update', id, patch: { 'phones/p1/number': '2' } }],
    });
  });

  describe('a small photo the provider keeps as its thumbnail only (no PHOTO_FILE_ID)', () => {
    const photo = { ph: { kind: 'photo', uri: `data:image/jpeg;base64,${JPEG}`, mediaType: 'image/jpeg' } };
    const small = () => ({ name: { full: 'Photo Smalltest' }, emails: { e1: { address: 'small@example.org' } }, notes: { n1: { note: 'v1' } }, media: photo });
    const photos = (h: Harness, rawId: number) => h.device.rows('data', 'raw_contact_id = ? AND mimetype = ?', [rawId, MimeType.PHOTO]);

    it('keeps one row through downloads and merges, and never reads it as deleted', async () => {
      const h = new Harness();
      const { id, rawId } = await h.seed(small());
      expect(photos(h, rawId)).toMatchObject([{ data14: null, data_sync1: 'media:ph' }]);
      await expectSettled(h, id, rawId);
      for (const note of ['v2', 'v3']) {
        h.server.serverUpdate('ContactCard', JMAP, id, { 'notes/n1/note': note });
        await h.download(id);
        expect(photos(h, rawId)).toHaveLength(1);
      }
      // A merge into an edited contact.
      h.device.user.updateData(h.rowsByKey(rawId)['emails:e1']._id as number, { data1: 'small2@example.org' });
      h.server.serverUpdate('ContactCard', JMAP, id, { 'notes/n1/note': 'v4' });
      await h.applyOk(h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx).ops);
      expect(photos(h, rawId)).toHaveLength(1);
      // An edit of another field uploads alone.
      expect(h.planner.planUpload(await h.contact(rawId), h.ctx)).toEqual({
        kind: 'upload', actions: [{ kind: 'update', id, patch: { 'emails/e1/address': 'small2@example.org' } }],
      });
      await h.upload(rawId);
      expect(h.card(id).media).toEqual(photo);
      expect(photos(h, rawId)).toHaveLength(1);
      await expectSettled(h, id, rawId);
      // A photo set on the device (it gets a display photo) replaces it.
      h.device.user.setPhoto(rawId, JPEG2);
      h.devicePhotos.set(rawId, JPEG2);
      expect(h.planner.planUpload(await h.contact(rawId), h.ctx)).toEqual({
        kind: 'upload', actions: [{ kind: 'update', id, patch: { 'media/ph/uri': `data:image/jpeg;base64,${JPEG2}`, 'media/ph/mediaType': 'image/jpeg' } }],
      });
    });

    it('heals the photo rows the same photo was inserted as again, keeping one and the server photo', async () => {
      const h = new Harness();
      const { id, rawId } = await h.seed(small());
      const [row] = photos(h, rawId);
      const again = { [Data.MIMETYPE]: MimeType.PHOTO, [Data.DATA15]: { b64: JPEG }, data_sync1: row.data_sync1, data_sync2: row.data_sync2, data_sync3: row.data_sync3 };
      for (let i = 0; i < 2; i++) await h.applyOk({ ref: 'again', ops: [{ op: 'insert', table: 'data', values: { ...again, [Data.RAW_CONTACT_ID]: rawId } }] });
      expect(photos(h, rawId)).toHaveLength(3);
      // An edit on the device uploads without touching the photo, and its accepted write keeps one row.
      h.device.user.updateData(h.rowsByKey(rawId)['notes:n1']._id as number, { data1: 'v2 edited on device' });
      expect(h.planner.planUpload(await h.contact(rawId), h.ctx)).toEqual({
        kind: 'upload', actions: [{ kind: 'update', id, patch: { 'notes/n1/note': 'v2 edited on device' } }],
      });
      await h.upload(rawId);
      expect(photos(h, rawId)).toHaveLength(1);
      expect(h.card(id).media).toEqual(photo);
      await expectSettled(h, id, rawId);
      // An unchanged card downloaded again (a full reconcile) heals too.
      for (let i = 0; i < 2; i++) await h.applyOk({ ref: 'again', ops: [{ op: 'insert', table: 'data', values: { ...again, [Data.RAW_CONTACT_ID]: rawId } }] });
      await h.applyOk(h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx).ops);
      expect(photos(h, rawId)).toHaveLength(1);
    });
  });

  it('heals a baseline the provider stored differently from the prediction', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed({ name: { full: 'Dr. Jane Q. Public' } });
    const name = h.rowsByKey(rawId).name;
    // The real NameSplitter knows titles and middle names; the prediction does not.
    await h.applyOk({ ref: 'split', ops: [{ op: 'update', table: 'data', id: name._id as number, values: { data4: 'Dr.', data2: 'Jane', data5: 'Q.', data3: 'Public' } }] });
    const heal = h.planner.planBaselineHeal(await h.contact(rawId));
    expect(heal?.ops.map((o) => o.op)).toEqual(['assert', 'update']);
    await h.applyOk(heal!);
    await expectSettled(h, id, rawId);
    h.device.user.star(rawId);
    expect((await h.upload(rawId)).kind).toBe('clean');
  });

  it('does not heal a dirty contact: its edit must still count', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.updateData(h.rowsByKey(rawId)['notes:n1']._id as number, { data1: 'edited' });
    expect(h.planner.planBaselineHeal(await h.contact(rawId))).toBeNull();
  });
});
