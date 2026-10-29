import { describe, expect, it } from 'vitest';
import { Data, MimeType, RawContacts } from '../../android-columns';
import { contactFingerprint } from '../../contacts/planner';
import type { Row } from '../../types';
import { appleCard, googleCard, JPEG2, probeCard } from './fixtures';
import { ACCOUNT, Harness, JMAP } from './harness';

/**
 * The rows Fossify Contacts writes back on save: every kind it models
 * re-inserted without DATA_SYNC, IS_PRIMARY or the columns it has no field
 * for (a department, a job description, a website's type), one nickname and
 * one organization only.
 */
function fossifyRows(h: Harness, rawId: number, edit: (rows: Row[]) => void = () => {}): Row[] {
  const out: Row[] = [];
  let nickname = false;
  let organization = false;
  for (const r of h.device.rows('data', 'raw_contact_id = ?', [rawId])) {
    const pick = (...columns: string[]) => {
      const row: Row = { [Data.MIMETYPE]: r[Data.MIMETYPE] };
      for (const c of columns) row[c] = r[c];
      out.push(row);
    };
    switch (r[Data.MIMETYPE]) {
      case MimeType.NICKNAME: if (!nickname) pick('data1'); nickname = true; break;
      case MimeType.PHONE: case MimeType.EMAIL: pick('data1', 'data2', 'data3'); break;
      case MimeType.STRUCTURED_POSTAL: pick('data1', 'data2'); break;
      case MimeType.EVENT: pick('data1', 'data2'); break;
      case MimeType.NOTE: pick('data1'); break;
      case MimeType.ORGANIZATION: if (!organization) pick('data1', 'data4'); organization = true; break;
      case MimeType.WEBSITE: out.push({ [Data.MIMETYPE]: MimeType.WEBSITE, data1: r.data1, data2: 1 }); break;
      case MimeType.GROUP_MEMBERSHIP: pick('data1'); break;
    }
  }
  edit(out);
  return out;
}

async function uploadPlan(h: Harness, rawId: number) {
  return h.planner.planUpload(await h.contact(rawId), h.ctx);
}

async function patchOf(h: Harness, rawId: number) {
  const plan = await uploadPlan(h, rawId);
  if (plan.kind !== 'upload' || plan.actions[0].kind !== 'update') throw new Error(`expected an update, got ${plan.kind}`);
  return plan.actions[0].patch;
}

describe('contacts upload: Fossify re-inserts rows', () => {
  it('uploads nothing for a save without changes, then restores what it dropped', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.fossifySave(rawId, null, fossifyRows(h, rawId));
    const plan = await uploadPlan(h, rawId);
    expect(plan.kind).toBe('clean');
    await h.upload(rawId);
    const rows = h.rowsByKey(rawId);
    expect(rows['organizations:o1|titles:t1,r1']).toMatchObject({ data1: 'ACME', data4: 'Chief Prober', data5: 'R&D', data6: 'Lead' });
    expect(Number(rows['links:l1'].data2)).toBe(5);
    expect(Number(rows['emails:work1'].is_primary)).toBe(1);
    expect(h.dirty(rawId)).toBe(false);
    expect(h.planner.planBaselineHeal(await h.contact(rawId))).toBeNull();
  });

  it('never clears the department it drops (a value-matched row has no baseline)', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.fossifySave(rawId, null, fossifyRows(h, rawId, (rows) => {
      rows.find((r) => r[Data.MIMETYPE] === MimeType.ORGANIZATION)!.data4 = 'Chief Tester';
    }));
    expect(await patchOf(h, rawId)).toEqual({ 'titles/t1/name': 'Chief Tester' });
  });

  it('uploads the one email it changed, matching the others by value', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(appleCard());
    h.device.user.fossifySave(rawId, null, fossifyRows(h, rawId, (rows) => {
      rows.find((r) => r.data1 === 'anna@work.example')!.data1 = 'anna@new.example';
    }));
    expect(await patchOf(h, rawId)).toEqual({ 'emails/k2/address': 'anna@new.example' });
  });

  it('keeps the second nickname it could not show, and puts it back on the device', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(googleCard());
    h.device.user.fossifySave(rawId, null, fossifyRows(h, rawId));
    expect((await uploadPlan(h, rawId)).kind).toBe('clean');
    await h.upload(rawId);
    expect(h.rowsByKey(rawId)['nicknames:k2'].data1).toBe('GKG');
    expect(h.card(id).nicknames).toEqual(googleCard().nicknames);
  });

  it('does not delete an entry it rewrote away (a documented limitation)', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(appleCard());
    h.device.user.fossifySave(rawId, null, fossifyRows(h, rawId, (rows) => {
      rows.splice(rows.findIndex((r) => r.data1 === 'anna@work.example'), 1);
    }));
    expect((await uploadPlan(h, rawId)).kind).toBe('clean');
  });
});

describe('contacts upload: deletions (in-place editor)', () => {
  it('resends the map minus the entry, its other entries as the server has them', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(probeCard());
    h.device.user.deleteData(h.rowsByKey(rawId)['emails:zz9']._id as number);
    const { emails } = h.card(id) as { emails: Record<string, unknown> };
    expect(await patchOf(h, rawId)).toEqual({ emails: { work1: emails.work1, 'x/y': emails['x/y'] } });
  });

  it('deletes an address with a null (clean on Stalwart)', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.deleteData(h.rowsByKey(rawId)['addresses:home']._id as number);
    expect(await patchOf(h, rawId)).toEqual({ 'addresses/home': null });
  });

  it('keeps the notes after the first when the note is deleted', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.deleteData(h.rowsByKey(rawId)['notes:n1']._id as number);
    expect(await patchOf(h, rawId)).toEqual({ notes: { n2: { note: 'second note' } } });
  });

  it('removes a map whose last entry went, when other rows show an in-place editor', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.deleteData(h.rowsByKey(rawId)['nicknames:nk']._id as number);
    expect(await patchOf(h, rawId)).toEqual({ nicknames: null });
  });

  it('deletes an organization with its titles', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.deleteData(h.rowsByKey(rawId)['organizations:o1|titles:t1,r1']._id as number);
    expect(await patchOf(h, rawId)).toEqual({ organizations: null, titles: null });
  });

  it('deletes the photo', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.deleteData(h.rowsByKey(rawId)['media:ph']._id as number);
    expect(await patchOf(h, rawId)).toEqual({ media: null });
  });

  it('deletes a relation by resending relatedTo (Stalwart ignores a null there)', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.deleteData(h.rowsByKey(rawId)['relatedTo:urn:uuid:other-person']._id as number);
    expect(await patchOf(h, rawId)).toEqual({ relatedTo: null });
  });

  it('folds an edit into a map it resends', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(probeCard());
    const rows = h.rowsByKey(rawId);
    h.device.user.deleteData(rows['emails:zz9']._id as number);
    h.device.user.updateData(rows['emails:work1']._id as number, { data1: 'new@work.example' });
    const { emails } = h.card(id) as unknown as { emails: Record<string, Record<string, unknown>> };
    expect(await patchOf(h, rawId)).toEqual({ emails: { work1: { ...emails.work1, address: 'new@work.example' }, 'x/y': emails['x/y'] } });
  });
});

describe('contacts upload: additions', () => {
  it('adds an entry to an existing map under a new key', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.insertData(rawId, { [Data.MIMETYPE]: MimeType.EMAIL, data1: 'added@example.org', data2: 2 });
    const patch = await patchOf(h, rawId);
    const [pointer] = Object.keys(patch);
    expect(pointer).toMatch(/^emails\/b[0-9a-z]{8}$/);
    expect(patch[pointer]).toEqual({ address: 'added@example.org', contexts: { work: true } });
  });

  it('sends the whole map for the first entry of a map', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(appleCard());
    h.device.user.insertData(rawId, { [Data.MIMETYPE]: MimeType.WEBSITE, data1: 'https://anna.example', data2: 7 });
    const patch = await patchOf(h, rawId);
    expect(Object.keys(patch)).toEqual(['links']);
    expect(Object.values(patch.links as object)).toEqual([{ uri: 'https://anna.example' }]);
  });

  it('adds a work phone with its features and contexts', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.insertData(rawId, { [Data.MIMETYPE]: MimeType.PHONE, data1: '+49 89 1', data2: 3 });
    expect(Object.values(await patchOf(h, rawId))).toEqual([{ number: '+49 89 1', features: { voice: true }, contexts: { work: true } }]);
  });

  it('adds an organization and a title that points at it', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(appleCard());
    h.device.user.insertData(rawId, { [Data.MIMETYPE]: MimeType.ORGANIZATION, data1: 'Apple', data4: 'Engineer' });
    const patch = await patchOf(h, rawId) as { organizations: Record<string, unknown>; titles: Record<string, Record<string, unknown>> };
    const [orgKey] = Object.keys(patch.organizations);
    expect(patch.organizations[orgKey]).toEqual({ name: 'Apple' });
    expect(Object.values(patch.titles)).toEqual([{ name: 'Engineer', kind: 'title', organizationId: orgKey }]);
  });

  it('adds a relation keyed by its name', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.insertData(rawId, { [Data.MIMETYPE]: MimeType.RELATION, data1: 'Jane Doe', data2: 14 });
    expect(await patchOf(h, rawId)).toEqual({ 'relatedTo/Jane Doe': { relation: { spouse: true } } });
  });

  it('adds a photo from the device as a JPEG data URI', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(appleCard());
    h.device.user.setPhoto(rawId, JPEG2);
    h.devicePhotos.set(rawId, JPEG2);
    const patch = await patchOf(h, rawId);
    expect(Object.values(patch.media as object)).toEqual([{ kind: 'photo', uri: `data:image/jpeg;base64,${JPEG2}`, mediaType: 'image/jpeg' }]);
  });

  it('replaces a changed photo in place', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.setPhoto(rawId, JPEG2);
    h.devicePhotos.set(rawId, JPEG2);
    expect(await patchOf(h, rawId)).toEqual({ 'media/ph/uri': `data:image/jpeg;base64,${JPEG2}`, 'media/ph/mediaType': 'image/jpeg' });
  });
});

describe('contacts upload: new contacts', () => {
  function insertNew(h: Harness): number {
    return h.device.user.insertContact(ACCOUNT, [
      { [Data.MIMETYPE]: MimeType.STRUCTURED_NAME, data1: 'Neu Person', data2: 'Neu', data3: 'Person' },
      { [Data.MIMETYPE]: MimeType.EMAIL, data1: 'neu@example.org', data2: 1, is_primary: 1 },
      { [Data.MIMETYPE]: MimeType.PHONE, data1: '+49 1', data2: 2 },
      { [Data.MIMETYPE]: MimeType.STRUCTURED_POSTAL, data1: 'Weg 1, 12345 Ort', data2: 1, data4: 'Weg 1', data7: 'Ort', data9: '12345' },
      { [Data.MIMETYPE]: MimeType.EVENT, data1: '1990-01-02', data2: 3 },
      { [Data.MIMETYPE]: MimeType.NOTE, data1: 'hello' },
      { [Data.MIMETYPE]: MimeType.NICKNAME, data1: 'Neuling' },
    ]);
  }

  it('claims a uid and target first, then creates the card from its rows', async () => {
    const h = new Harness();
    const rawId = insertNew(h);
    const claim = h.planner.planUpload(await h.contact(rawId), h.ctx);
    expect(claim.kind).toBe('claim');
    await h.applyOk((claim as { ops: import('../../planner').OpGroup }).ops);
    const pending = (await h.contact(rawId)).pending!;
    expect(pending.target).toBe(`${JMAP}/${h.book}`);
    const plan = h.planner.planUpload(await h.contact(rawId), h.ctx);
    if (plan.kind !== 'upload' || plan.actions[0].kind !== 'create') throw new Error(plan.kind);
    const { object, uid, collectionId } = plan.actions[0];
    expect(uid).toBe(pending.uid);
    expect(collectionId).toBe(h.book);
    const values = (map: unknown) => Object.values(map as object);
    expect(object).toMatchObject({ '@type': 'Card', version: '1.0', uid: pending.uid, addressBookIds: { [h.book]: true } });
    expect(object.name).toEqual({ components: [{ kind: 'given', value: 'Neu' }, { kind: 'surname', value: 'Person' }], full: 'Neu Person' });
    expect(values(object.emails)).toEqual([{ address: 'neu@example.org', contexts: { private: true }, pref: 1 }]);
    expect(values(object.phones)).toEqual([{ number: '+49 1', features: { mobile: true } }]);
    expect(values(object.addresses)).toEqual([{
      components: [{ kind: 'name', value: 'Weg 1' }, { kind: 'locality', value: 'Ort' }, { kind: 'postcode', value: '12345' }],
      full: 'Weg 1, 12345 Ort',
      contexts: { private: true },
    }]);
    expect(values(object.anniversaries)).toEqual([{ kind: 'birth', date: { '@type': 'PartialDate', year: 1990, month: 1, day: 2 } }]);
    expect(values(object.notes)).toEqual([{ note: 'hello' }]);
    expect(values(object.nicknames)).toEqual([{ name: 'Neuling' }]);
    expect(Object.keys(object).sort()).toEqual([
      '@type', 'addressBookIds', 'addresses', 'anniversaries', 'emails', 'name', 'nicknames', 'notes', 'phones', 'uid', 'version',
    ]);
  });

  it('takes the identity after the create and writes nothing when the card comes back', async () => {
    const h = new Harness();
    const rawId = insertNew(h);
    await h.upload(rawId);
    const local = await h.contact(rawId);
    expect(local).toMatchObject({ dirty: false, pending: null });
    expect(local.sourceId).toMatch(/^c\//);
    expect(local.rows.every((r) => r.key !== null)).toBe(true);
    const plan = h.planner.planDownload(h.card(h.cardIdOf(local)), local, h.ctx);
    expect(plan.effect).toBe('none');
  });

  it('is skipped when no writable book is selected', async () => {
    const h = new Harness();
    const rawId = insertNew(h);
    const plan = h.planner.planUpload(await h.contact(rawId), { ...h.ctx, createTarget: () => null });
    expect(plan).toEqual({ kind: 'skip', reason: 'noWritableAddressBook' });
  });
});

describe('contacts upload: deleted contacts', () => {
  it('destroys the card, then purges the rows', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed(appleCard());
    h.device.user.deleteContact(rawId);
    const plan = await uploadPlan(h, rawId);
    expect(plan).toEqual({ kind: 'upload', actions: [{ kind: 'destroy', id, uid: appleCard().uid }] });
    await h.upload(rawId);
    expect(h.device.row('raw_contacts', rawId)).toBeUndefined();
    expect(h.server.get('ContactCard', JMAP, id)).toBeUndefined();
  });

  it('only leaves the synced book of a card that is also in an unsynced one', async () => {
    const h = new Harness();
    const other = h.server.addAddressBook(JMAP, { name: 'Other' });
    h.unselected.add(`${JMAP}/${other}`);
    const { rawId } = await h.seed({ ...appleCard(), addressBookIds: { [h.book]: true, [other]: true } });
    h.device.user.deleteContact(rawId);
    expect(await patchOf(h, rawId)).toEqual({ [`addressBookIds/${h.book}`]: null });
  });

  it('only leaves the synced book when the server filed the card in an unsynced one after the device deleted it', async () => {
    const h = new Harness();
    const archive = h.server.addAddressBook(JMAP, { name: 'Archive' });
    h.unselected.add(`${JMAP}/${archive}`);
    const { id, rawId } = await h.seed(appleCard());
    h.device.user.deleteContact(rawId);
    h.server.serverUpdate('ContactCard', JMAP, id, { [`addressBookIds/${archive}`]: true, 'emails/k1/address': 'new@example.com' });
    const rows = JSON.stringify(h.device.rows('data', 'raw_contact_id = ?', [rawId]));
    await h.applyOk(h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx).ops);
    // The delete wins over the server's edit: the rows stay as they were, only the shadow follows.
    expect(JSON.stringify(h.device.rows('data', 'raw_contact_id = ?', [rawId]))).toBe(rows);
    expect(await uploadPlan(h, rawId)).toEqual({ kind: 'upload', actions: [{ kind: 'update', id, patch: { [`addressBookIds/${h.book}`]: null } }] });
    await h.upload(rawId);
    expect(h.server.get('ContactCard', JMAP, id)).toMatchObject({ addressBookIds: { [archive]: true } });
    expect(h.device.row('raw_contacts', rawId)).toBeUndefined();
  });

  it('leaves a card the server moved out of every synced book before the deletion reached it, and only purges the rows', async () => {
    const h = new Harness();
    const archive = h.server.addAddressBook(JMAP, { name: 'Archive' });
    h.unselected.add(`${JMAP}/${archive}`);
    const { id, rawId } = await h.seed(appleCard());
    h.device.user.deleteContact(rawId);
    h.server.serverUpdate('ContactCard', JMAP, id, { addressBookIds: { [archive]: true } });
    await h.applyOk(h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx).ops);
    expect(await uploadPlan(h, rawId)).toMatchObject({ kind: 'purge' });
    await h.upload(rawId);
    expect(h.device.row('raw_contacts', rawId)).toBeUndefined();
    expect(h.server.get('ContactCard', JMAP, id)).toMatchObject({ addressBookIds: { [archive]: true } });
  });

  it('still destroys a card the server moved to another synced book, or whose book was deselected before the upload', async () => {
    const moved = new Harness();
    const work = moved.server.addAddressBook(JMAP, { name: 'Work' });
    const a = await moved.seed(appleCard());
    moved.device.user.deleteContact(a.rawId);
    moved.server.serverUpdate('ContactCard', JMAP, a.id, { addressBookIds: { [work]: true } });
    await moved.applyOk(moved.planner.planDownload(moved.card(a.id), await moved.contact(a.rawId), moved.ctx).ops);
    expect(await uploadPlan(moved, a.rawId)).toEqual({ kind: 'upload', actions: [{ kind: 'destroy', id: a.id, uid: appleCard().uid }] });

    const deselected = new Harness();
    const b = await deselected.seed(appleCard());
    deselected.device.user.deleteContact(b.rawId);
    deselected.unselected.add(`${JMAP}/${deselected.book}`);
    expect(await uploadPlan(deselected, b.rawId)).toEqual({ kind: 'upload', actions: [{ kind: 'destroy', id: b.id, uid: appleCard().uid }] });
  });

  it('deletes its own create by id once the download found it, not by a uid lookup', async () => {
    const h = new Harness();
    const rawId = h.device.user.insertContact(ACCOUNT, [{ [Data.MIMETYPE]: MimeType.NOTE, data1: 'y' }]);
    const plan = await h.planUpload(rawId);
    if (plan.kind !== 'upload') throw new Error(plan.kind);
    // The create went through but its response was lost; then the user deleted the contact.
    const id = h.send(plan.actions)!;
    h.device.user.deleteContact(rawId);
    await h.applyOk(h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx).ops);
    expect(await h.contact(rawId)).toMatchObject({ sourceId: `${JMAP}/${id}`, pending: null, deleted: true });
    expect(await uploadPlan(h, rawId)).toEqual({ kind: 'upload', actions: [{ kind: 'destroy', id, uid: h.card(id).uid }] });
  });

  it('purges a new contact that never reached the server, and destroys a claimed one by uid', async () => {
    const h = new Harness();
    const fresh = h.device.user.insertContact(ACCOUNT, [{ [Data.MIMETYPE]: MimeType.NOTE, data1: 'x' }]);
    h.device.user.deleteContact(fresh);
    expect((await uploadPlan(h, fresh)).kind).toBe('purge');
    const claimed = h.device.user.insertContact(ACCOUNT, [{ [Data.MIMETYPE]: MimeType.NOTE, data1: 'y' }]);
    await h.planUpload(claimed);
    const uid = (await h.contact(claimed)).pending!.uid;
    h.device.user.deleteContact(claimed);
    expect(await uploadPlan(h, claimed)).toEqual({ kind: 'upload', actions: [{ kind: 'destroy', id: null, uid }] });
  });
});

describe('contacts upload: read-only and poisoned contacts', () => {
  it('reverts an edit of a read-only contact from the shadow', async () => {
    const h = new Harness();
    h.readOnlyBooks.add(h.book);
    const { rawId } = await h.seed(appleCard());
    h.device.user.updateData(h.rowsByKey(rawId)['emails:k1']._id as number, { data1: 'hacked@example.org' });
    const plan = await uploadPlan(h, rawId);
    expect(plan).toMatchObject({ kind: 'revert', reason: 'readOnly' });
    await h.upload(rawId);
    expect(h.rowsByKey(rawId)['emails:k1'].data1).toBe('anna@example.com');
    expect(h.dirty(rawId)).toBe(false);
  });

  it('purges a deleted read-only contact and asks for it again', async () => {
    const h = new Harness();
    h.readOnlyBooks.add(h.book);
    const { rawId } = await h.seed(appleCard());
    h.device.user.deleteContact(rawId);
    expect(await uploadPlan(h, rawId)).toMatchObject({ kind: 'revert', refetch: true, reason: 'readOnly' });
  });

  it('skips a poisoned contact until it changes or the back-off ends', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(appleCard());
    const email = h.rowsByKey(rawId)['emails:k1']._id as number;
    h.device.user.updateData(email, { data1: 'bad@example.org' });
    const poison = { fp: contactFingerprint(await h.contact(rawId)), type: 'invalidProperties', n: 1, until: h.ctx.now + 3_600_000 };
    await h.applyOk({ ref: 'x', ops: [{ op: 'update', table: 'raw_contacts', id: rawId, values: { [RawContacts.SYNC4]: JSON.stringify(poison) } }] });
    expect(await uploadPlan(h, rawId)).toEqual({ kind: 'skip', reason: 'poisoned:invalidProperties' });
    expect(h.planner.planUpload(await h.contact(rawId), { ...h.ctx, now: poison.until + 1 }).kind).toBe('upload');
    h.device.user.updateData(email, { data1: 'good@example.org' });
    expect((await uploadPlan(h, rawId)).kind).toBe('upload');
  });
});
