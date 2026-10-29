import { describe, expect, it } from 'vitest';
import { Data, MimeType, RawContacts } from '../../android-columns';
import type { ContactCardWire } from '../../planner';
import { appleCard, googleCard, probeCard } from './fixtures';
import { Harness, JMAP } from './harness';

/** A seeded card, edited on the device (in place, like AOSP) and on the server. */
async function bothEdited(
  make: () => Record<string, unknown>,
  device: (h: Harness, rawId: number) => void,
  server: Record<string, unknown>,
) {
  const h = new Harness();
  const { id, rawId } = await h.seed(make());
  device(h, rawId);
  h.server.serverUpdate('ContactCard', JMAP, id, server);
  const plan = h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx);
  await h.applyOk(plan.ops);
  return { h, id, rawId, plan };
}

const edit = (key: string, values: Record<string, string | number | null>) => (h: Harness, rawId: number) =>
  h.device.user.updateData(h.rowsByKey(rawId)[key]._id as number, values);

async function patchOf(h: Harness, rawId: number) {
  const plan = h.planner.planUpload(await h.contact(rawId), h.ctx);
  return plan.kind === 'upload' && plan.actions[0].kind === 'update' ? plan.actions[0].patch : plan.kind;
}

describe('contacts merge: a dirty contact meets a new server version', () => {
  it('lets the server win a real conflict and counts it', async () => {
    const { h, rawId, plan } = await bothEdited(appleCard, edit('emails:k1', { data1: 'mine@example.com' }), { 'emails/k1/address': 'theirs@example.com' });
    expect(plan).toMatchObject({ conflicts: 1, stillDirty: false, effect: 'update' });
    expect(h.rowsByKey(rawId)['emails:k1'].data1).toBe('theirs@example.com');
    expect(h.dirty(rawId)).toBe(true);
    expect(await patchOf(h, rawId)).toBe('clean');
  });

  it('keeps a local edit of one unit and takes the server edit of another', async () => {
    const { h, rawId, plan } = await bothEdited(appleCard, edit('phones:k1', { data1: '+1 555 0199' }), { 'emails/k2/address': 'anna@new.example' });
    expect(plan).toMatchObject({ conflicts: 0, stillDirty: true });
    expect(h.rowsByKey(rawId)['emails:k2'].data1).toBe('anna@new.example');
    expect(await patchOf(h, rawId)).toEqual({ 'phones/k1/number': '+1 555 0199' });
  });

  it('treats the same change on both sides as converged', async () => {
    const { h, rawId, plan } = await bothEdited(appleCard, edit('emails:k1', { data1: 'same@example.com' }), { 'emails/k1/address': 'same@example.com' });
    expect(plan).toMatchObject({ conflicts: 0, stillDirty: false });
    expect(await patchOf(h, rawId)).toBe('clean');
  });

  it('does not count a server change to a sub-field Android does not show', async () => {
    const { h, id, rawId, plan } = await bothEdited(appleCard, edit('emails:k1', { data1: 'mine@example.com' }), { 'emails/k1/contexts': { private: true, school: true } });
    expect(plan.conflicts).toBe(0);
    expect(await patchOf(h, rawId)).toEqual({ 'emails/k1/address': 'mine@example.com' });
    await h.upload(rawId);
    expect(h.card(id).emails!.k1).toMatchObject({ address: 'mine@example.com', contexts: { private: true, school: true } });
  });

  it('deletes a row the server deleted, over a local edit (counted)', async () => {
    const { h, rawId, plan } = await bothEdited(appleCard, edit('phones:k3', { data1: '+1 555 0177' }), { 'phones/k3': null });
    expect(plan.conflicts).toBe(1);
    expect(h.rowsByKey(rawId)['phones:k3']).toBeUndefined();
  });

  it('puts back an entry deleted on the device that the server changed (counted)', async () => {
    const { h, rawId, plan } = await bothEdited(
      appleCard,
      (hh, raw) => hh.device.user.deleteData(hh.rowsByKey(raw)['phones:k3']._id as number),
      { 'phones/k3/number': '+1 555 0188' },
    );
    expect(plan.conflicts).toBe(1);
    expect(h.rowsByKey(rawId)['phones:k3'].data1).toBe('+1 555 0188');
  });

  it('keeps a device deletion of an entry the server left alone', async () => {
    const { h, rawId, plan } = await bothEdited(
      appleCard,
      (hh, raw) => hh.device.user.deleteData(hh.rowsByKey(raw)['phones:k3']._id as number),
      { 'emails/k2/address': 'anna@new.example' },
    );
    expect(plan).toMatchObject({ conflicts: 0, stillDirty: true });
    const patch = await patchOf(h, rawId) as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual(['phones']);
    expect(Object.keys(patch.phones as object)).toEqual(['k1', 'k2']);
  });

  it('still uploads a photo deleted on the device after merging a server edit of another entry', async () => {
    const { h, rawId, plan } = await bothEdited(
      probeCard,
      (hh, raw) => hh.device.user.deleteData(hh.rowsByKey(raw)['media:ph']._id as number),
      { 'emails/zz9/address': 'new@example.org' },
    );
    expect(plan).toMatchObject({ conflicts: 0, stillDirty: true });
    expect(await patchOf(h, rawId)).toEqual({ media: null });
  });

  it('matches an entry both sides added instead of duplicating it', async () => {
    const { h, rawId, plan } = await bothEdited(
      appleCard,
      (hh, raw) => hh.device.user.insertData(raw, { [Data.MIMETYPE]: MimeType.EMAIL, data1: 'both@example.com', data2: 3 }),
      { 'emails/k3': { address: 'both@example.com' } },
    );
    expect(plan.conflicts).toBe(0);
    const emails = h.device.rows('data', 'raw_contact_id = ? AND mimetype = ?', [rawId, MimeType.EMAIL]);
    expect(emails.filter((r) => r.data1 === 'both@example.com')).toHaveLength(1);
    expect(await patchOf(h, rawId)).toBe('clean');
  });

  it('inserts what the server added next to a pending local edit', async () => {
    const { h, rawId, plan } = await bothEdited(appleCard, edit('phones:k1', { data1: '+1 555 0199' }), { 'emails/k3': { address: 'third@example.com' } });
    expect(plan.stillDirty).toBe(true);
    expect(h.rowsByKey(rawId)['emails:k3'].data1).toBe('third@example.com');
    expect(await patchOf(h, rawId)).toEqual({ 'phones/k1/number': '+1 555 0199' });
  });

  it('follows shifted keys and uploads the local edit under the new key', async () => {
    const { h, rawId, plan } = await bothEdited(appleCard, edit('emails:k2', { data1: 'anna@work2.example' }), {
      emails: {
        k1: { address: 'first@example.com' },
        k2: { address: 'anna@example.com', contexts: { private: true }, pref: 1 },
        k3: { address: 'anna@work.example', contexts: { work: true } },
      },
    });
    expect(plan.conflicts).toBe(0);
    const rows = h.rowsByKey(rawId);
    expect(rows['emails:k3'].data1).toBe('anna@work2.example');
    expect(rows['emails:k1'].data1).toBe('first@example.com');
    expect(await patchOf(h, rawId)).toEqual({ 'emails/k3/address': 'anna@work2.example' });
  });

  it('merges the name as one unit: a typed name on the server beats a local component edit', async () => {
    const { h, rawId, plan } = await bothEdited(appleCard, edit('name', { data2: 'Annie', data1: 'Annie Apfel' }), { 'name/full': 'A. Apfel' });
    expect(plan.conflicts).toBe(1);
    expect(h.rowsByKey(rawId).name).toMatchObject({ data1: 'A. Apfel', data2: 'Anna' });
  });

  it('never gives keys to a kind an editor rewrote, so a nickname it could not show is not deleted later', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(googleCard());
    // Fossify keeps one nickname, re-inserted without its key.
    h.device.user.fossifySave(rawId, null, [{ [Data.MIMETYPE]: MimeType.NICKNAME, data1: 'Gü' }]);
    h.server.serverUpdate('ContactCard', JMAP, id, { 'nicknames/k1/name': 'Guenther' });
    const plan = h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx);
    await h.applyOk(plan.ops);
    const nick = h.device.rows('data', 'raw_contact_id = ? AND mimetype = ?', [rawId, MimeType.NICKNAME]);
    expect(nick.map((r) => [r.data1, r.data_sync1])).toEqual([['Guenther', null]]);
    const patch = await patchOf(h, rawId);
    expect(typeof patch === 'object' && Object.keys(patch).some((k) => k.startsWith('nicknames'))).toBe(false);
  });

  it('leaves the rows of a contact deleted on the device alone: the delete wins and uploads', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(appleCard());
    h.device.user.deleteContact(rawId);
    h.server.serverUpdate('ContactCard', JMAP, id, { 'emails/k1/address': 'x@example.com' });
    const plan = h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx);
    // Only the shadow follows the card, for the deletion's upload.
    expect(plan).toMatchObject({ effect: 'update', stillDirty: true, conflicts: 0 });
    expect(plan.ops.ops.filter((o) => o.op !== 'assert')).toEqual([{
      op: 'update', table: 'raw_contacts', id: rawId, expectCount: 1,
      values: { [RawContacts.SYNC2]: expect.any(String) },
    }]);
    await h.applyOk(plan.ops);
    expect(h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx)).toMatchObject({ effect: 'none', ops: { ops: [] } });
    expect(h.planner.planUpload(await h.contact(rawId), h.ctx)).toMatchObject({ kind: 'upload', actions: [{ kind: 'destroy', id }] });
  });

  it('replaces the rows of a different object behind the same id (another uid)', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(appleCard());
    edit('emails:k1', { data1: 'mine@example.com' })(h, rawId);
    const other = { ...(googleCard() as object), id, addressBookIds: { [h.book]: true } } as unknown as ContactCardWire;
    const plan = h.planner.planDownload(other, await h.contact(rawId), h.ctx);
    await h.applyOk(plan.ops);
    const rows = h.rowsByKey(rawId);
    expect(rows['emails:k1']).toBeUndefined();
    expect(rows['nicknames:k1'].data1).toBe('Gü');
    expect(h.dirty(rawId)).toBe(false);
  });
});
