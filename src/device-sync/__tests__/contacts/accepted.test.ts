import { describe, expect, it } from 'vitest';
import { RawContacts } from '../../android-columns';
import { sha256Hex } from '../../../lib/sha256';
import { base64ToBytes } from '../../contacts/photo';
import { appleCard, JPEG2, probeCard } from './fixtures';
import { Harness } from './harness';

async function patchOf(h: Harness, rawId: number) {
  const plan = h.planner.planUpload(await h.contact(rawId), h.ctx);
  return plan.kind === 'upload' && plan.actions[0].kind === 'update' ? plan.actions[0].patch : plan.kind;
}

describe('contacts planAccepted', () => {
  it('writes the new shadow and baselines and clears DIRTY behind the VERSION read before the upload', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(appleCard());
    const email = h.rowsByKey(rawId)['emails:k1']._id as number;
    h.device.user.updateData(email, { data1: 'new@example.com' });
    const local = await h.contact(rawId);
    const plan = h.planner.planUpload(local, h.ctx);
    if (plan.kind !== 'upload') throw new Error(plan.kind);
    h.send(plan.actions);
    const accepted = h.planner.planAccepted(local, h.card(id), h.ctx);
    expect(accepted.ops.ops[0]).toEqual({ op: 'assert', table: 'raw_contacts', id: rawId, values: { version: local.version }, expectCount: 1 });
    await h.applyOk(accepted.ops);
    const after = await h.contact(rawId);
    expect(after.dirty).toBe(false);
    expect(after.shadow?.emails).toEqual(h.card(id).emails);
    expect(after.rows.find((r) => r.id === email)?.baseline?.data1).toBe('new@example.com');
    expect(h.planner.planDownload(h.card(id), after, h.ctx).effect).toBe('none');
    expect(h.planner.planBaselineHeal(after)).toBeNull();
  });

  it('keeps DIRTY and uploads only the newer edit when the contact was edited during the upload', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(appleCard());
    const rows = h.rowsByKey(rawId);
    h.device.user.updateData(rows['emails:k1']._id as number, { data1: 'first@example.com' });
    await h.upload(rawId, () => h.device.user.updateData(rows['phones:k1']._id as number, { data1: '+1 555 0142' }));
    expect(h.dirty(rawId)).toBe(true);
    expect(await patchOf(h, rawId)).toEqual({ 'phones/k1/number': '+1 555 0142' });
  });

  it('uploads a second edit of the same field made during the upload, and a revert to the old value', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(appleCard());
    const email = h.rowsByKey(rawId)['emails:k1']._id as number;
    h.device.user.updateData(email, { data1: 'a1@example.com' });
    await h.upload(rawId, () => h.device.user.updateData(email, { data1: 'a2@example.com' }));
    expect(await patchOf(h, rawId)).toEqual({ 'emails/k1/address': 'a2@example.com' });

    const h2 = new Harness();
    const seeded = await h2.seed(appleCard());
    const email2 = h2.rowsByKey(seeded.rawId)['emails:k1']._id as number;
    h2.device.user.updateData(email2, { data1: 'a1@example.com' });
    await h2.upload(seeded.rawId, () => h2.device.user.updateData(email2, { data1: 'anna@example.com' }));
    expect(await patchOf(h2, seeded.rawId)).toEqual({ 'emails/k1/address': 'anna@example.com' });
  });

  it('writes the identity of a create even when the contact changed meanwhile', async () => {
    const h = new Harness();
    const rawId = h.device.user.insertContact('usera@example.org', [
      { mimetype: 'vnd.android.cursor.item/name', data1: 'Late Edit', data2: 'Late', data3: 'Edit' },
    ]);
    await h.upload(rawId, () => h.device.user.star(rawId));
    const local = await h.contact(rawId);
    expect(local.sourceId).toMatch(/^c\//);
    expect(local.pending).toBeNull();
  });

  it('keeps the device photo after uploading it and records the server hash', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(probeCard());
    h.device.user.setPhoto(rawId, JPEG2);
    h.devicePhotos.set(rawId, JPEG2);
    const fileId = h.rowsByKey(rawId)['media:ph'].data14;
    await h.upload(rawId);
    const photo = h.rowsByKey(rawId)['media:ph'];
    expect(photo.data14).toBe(fileId);
    expect(photo.data_sync2).toBe(`sha256:${sha256Hex(base64ToBytes(JPEG2)!)}`);
    expect(h.dirty(rawId)).toBe(false);
    const local = await h.contact(rawId);
    expect(h.planner.planDownload(h.card(id), local, h.ctx).effect).toBe('none');
    expect(h.planner.planBaselineHeal(local)).toBeNull();
  });

  it('clears the poison marker and the pending create once accepted', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(appleCard());
    await h.applyOk({ ref: 'x', ops: [{ op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.SYNC4]: JSON.stringify({ fp: 'old', type: 'invalidProperties', n: 1, until: 1 }) } }] });
    h.device.user.updateData(h.rowsByKey(rawId)['emails:k1']._id as number, { data1: 'z@example.com' });
    await h.upload(rawId);
    expect(h.rawContact(rawId)[RawContacts.SYNC4]).toBeNull();
  });
});
