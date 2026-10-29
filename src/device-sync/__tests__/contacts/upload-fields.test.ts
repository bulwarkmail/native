import { describe, expect, it } from 'vitest';
import { Data, EmailType, MimeType, PhoneType, WebsiteType } from '../../android-columns';
import { deepEqual } from '../../common/json';
import { applyPatch, assertPatchWellFormed, type PatchObject } from '../../common/patch';
import type { ContactCardWire } from '../../planner';
import type { Row } from '../../types';
import { appleCard, googleCard, probeCard } from './fixtures';
import { Harness } from './harness';

/** Card data Android has no column for: every patch must leave it as it was. */
const UNMAPPED = [
  'onlineServices', 'speakToAs', 'keywords', 'personalInfo', 'preferredLanguages', 'notes/n2', 'name/phoneticSystem',
  'addresses/home/coordinates', 'addresses/home/timeZone', 'addresses/home/countryCode', 'kind', 'uid',
];

function at(card: unknown, path: string): unknown {
  return path.split('/').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), card);
}

/** Seeds a card, edits one row in place like AOSP Contacts, and returns the upload patch. */
async function editedPatch(make: () => Record<string, unknown>, key: string, values: Row): Promise<{ patch: PatchObject; card: ContactCardWire }> {
  const h = new Harness();
  const { id, rawId } = await h.seed(make());
  const row = h.rowsByKey(rawId)[key];
  if (!row) throw new Error(`no row ${key}`);
  h.device.user.updateData(row._id as number, values);
  const plan = h.planner.planUpload(await h.contact(rawId), h.ctx);
  if (plan.kind !== 'upload' || plan.actions[0].kind !== 'update') throw new Error(`expected an update, got ${plan.kind}`);
  return { patch: plan.actions[0].patch, card: h.card(id) };
}

const probeEdits: Array<[string, string, Row, PatchObject]> = [
  ['email address', 'emails:work1', { data1: 'new@work.example' }, { 'emails/work1/address': 'new@work.example' }],
  ['email type (home → work)', 'emails:zz9', { data2: 2 }, { 'emails/zz9/contexts': { work: true } }],
  ['email custom label', 'emails:work1', { data3: 'Desk' }, { 'emails/work1/label': 'Desk' }],
  ['a key with a slash', 'emails:x/y', { data1: 'slash2@example.org' }, { 'emails/x~1y/address': 'slash2@example.org' }],
  ['phone number', 'phones:p-a', { data1: '+49 30 5555' }, { 'phones/p-a/number': '+49 30 5555' }],
  ['phone type (mobile → work mobile)', 'phones:p-a', { data2: 17 }, { 'phones/p-a/contexts': { work: true }, 'phones/p-a/features': { mobile: true } }],
  ['nickname', 'nicknames:nk', { data1: 'Probster' }, { 'nicknames/nk/name': 'Probster' }],
  ['street', 'addresses:home', { data4: 'Hauptstr. 1' }, {
    'addresses/home/components': [
      { kind: 'name', value: 'Hauptstr. 1' },
      { kind: 'locality', value: 'Berlin' },
      { kind: 'postcode', value: '10115' },
      { kind: 'country', value: 'Germany' },
    ],
  }],
  ['city', 'addresses:home', { data7: 'Potsdam' }, {
    'addresses/home/components': [
      { kind: 'name', value: 'Main St' }, { kind: 'separator', value: ' ' }, { kind: 'number', value: '12' },
      { kind: 'locality', value: 'Potsdam' }, { kind: 'postcode', value: '10115' }, { kind: 'country', value: 'Germany' },
      { kind: 'apartment', value: '4b' },
    ],
  }],
  ['region, which the address did not have', 'addresses:home', { data8: 'Berlin' }, {
    'addresses/home/components': [
      { kind: 'name', value: 'Main St' }, { kind: 'separator', value: ' ' }, { kind: 'number', value: '12' },
      { kind: 'locality', value: 'Berlin' }, { kind: 'region', value: 'Berlin' }, { kind: 'postcode', value: '10115' },
      { kind: 'country', value: 'Germany' }, { kind: 'apartment', value: '4b' },
    ],
  }],
  ['formatted address', 'addresses:home', { data1: 'Main St 12\n10115 Berlin' }, { 'addresses/home/full': 'Main St 12\n10115 Berlin' }],
  ['address type (home → work)', 'addresses:home', { data2: 2 }, { 'addresses/home/contexts': { work: true } }],
  ['company', 'organizations:o1|titles:t1,r1', { data1: 'ACME Corp' }, { 'organizations/o1/name': 'ACME Corp' }],
  ['department', 'organizations:o1|titles:t1,r1', { data5: 'QA, Tools' }, { 'organizations/o1/units': [{ name: 'QA' }, { name: 'Tools' }] }],
  ['job title', 'organizations:o1|titles:t1,r1', { data4: 'Chief Tester' }, { 'titles/t1/name': 'Chief Tester' }],
  ['job description (role)', 'organizations:o1|titles:t1,r1', { data6: 'Mentor' }, { 'titles/r1/name': 'Mentor' }],
  ['website', 'links:l1', { data1: 'https://probe2.example' }, { 'links/l1/uri': 'https://probe2.example' }],
  ['website type (work → home)', 'links:l1', { data2: 4 }, { 'links/l1/contexts': { private: true } }],
  ['birthday date', 'anniversaries:bday', { data1: '--03-15' }, { 'anniversaries/bday/date': { '@type': 'PartialDate', month: 3, day: 15 } }],
  ['anniversary with a year', 'anniversaries:wed', { data1: '2011-06-01' }, { 'anniversaries/wed/date': { '@type': 'PartialDate', year: 2011, month: 6, day: 1 } }],
  ['anniversary type (birthday → other)', 'anniversaries:bday', { data2: 2 }, { 'anniversaries/bday/kind': 'other' }],
  ['relation type (friend → spouse)', 'relatedTo:urn:uuid:other-person', { data2: 14 }, { 'relatedTo/urn:uuid:other-person/relation': { spouse: true } }],
  ['relation type without an RFC twin (brother)', 'relatedTo:urn:uuid:other-person', { data2: 2 }, { 'relatedTo/urn:uuid:other-person/relation': { sibling: true } }],
  ['note', 'notes:n1', { data1: 'edited note' }, { 'notes/n1/note': 'edited note' }],
];

describe('contacts upload: one edited field, one pointer', () => {
  it.each(probeEdits)('%s', async (_name, key, values, expected) => {
    const { patch, card } = await editedPatch(probeCard, key, values);
    expect(patch).toEqual(expected);
    assertPatchWellFormed(patch);
    const applied = applyPatch(card, patch);
    expect(applied).not.toBeNull();
    for (const path of UNMAPPED) expect(deepEqual(at(applied, path), at(card, path))).toBe(true);
  });

  it('moves IS_PRIMARY as pref', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    const rows = h.rowsByKey(rawId);
    h.device.user.updateData(rows['emails:x/y']._id as number, { is_primary: 1 });
    h.device.user.updateData(rows['emails:work1']._id as number, { is_primary: 0 });
    const plan = h.planner.planUpload(await h.contact(rawId), h.ctx);
    expect(plan).toMatchObject({ kind: 'upload', actions: [{ kind: 'update', patch: { 'emails/x~1y/pref': 1, 'emails/work1/pref': null } }] });
  });

  it('renames a relation by moving it to the new key (relatedTo is keyed by value)', async () => {
    const { patch } = await editedPatch(probeCard, 'relatedTo:urn:uuid:other-person', { data1: 'Jane Roe' });
    expect(patch).toEqual({ relatedTo: { 'Jane Roe': { relation: { friend: true } } } });
  });

  it('keeps a free-text date the server cannot take on the device only', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(probeCard());
    h.device.user.updateData(h.rowsByKey(rawId)['anniversaries:bday']._id as number, { data1: 'next spring' });
    expect(h.planner.planUpload(await h.contact(rawId), h.ctx).kind).toBe('clean');
  });
});

describe('contacts upload: every device type comes back as the device wrote it', () => {
  const cases = (types: Record<string, number>, custom: number) =>
    Object.entries(types).map(([name, type]) => [name, type, type === custom ? 'Boat' : null] as const);
  const kinds = [
    { mimetype: MimeType.PHONE, value: '+49 30 1', map: 'phones', entry: { number: '+49 30 1', features: { voice: true } }, types: cases(PhoneType, PhoneType.CUSTOM) },
    { mimetype: MimeType.EMAIL, value: 'typed@example.org', map: 'emails', entry: { address: 'typed@example.org' }, types: cases(EmailType, EmailType.CUSTOM) },
    { mimetype: MimeType.WEBSITE, value: 'https://typed.example', map: 'links', entry: { uri: 'https://typed.example' }, types: cases(WebsiteType, WebsiteType.CUSTOM) },
  ];
  const typeOf = (row: Row) => [Number(row.data2), row.data3 ?? null];

  describe.each(kinds)('$map', ({ mimetype, value, map, entry, types }) => {
    it.each(types)('%s, on a contact created on the device', async (_name, type, label) => {
      const h = new Harness();
      const rawId = h.device.user.insertContact('usera@example.org', [
        { [Data.MIMETYPE]: MimeType.STRUCTURED_NAME, data1: 'Typed Person', data2: 'Typed', data3: 'Person' },
        { [Data.MIMETYPE]: mimetype, data1: value, data2: type, data3: label },
      ]);
      await h.upload(rawId);
      const [row] = h.device.rows('data', 'raw_contact_id = ? AND mimetype = ?', [rawId, mimetype]);
      expect(typeOf(row)).toEqual([type, label]);
      const local = await h.contact(rawId);
      expect(local.dirty).toBe(false);
      expect(h.planner.planDownload(h.card(h.cardIdOf(local)), local, h.ctx).effect).toBe('none');
    });

    it.each(types)('%s, chosen on the device for a synced entry', async (_name, type, label) => {
      const h = new Harness();
      const { id, rawId } = await h.seed({ name: { full: 'Typed Person' }, [map]: { e1: entry } });
      h.device.user.updateData(h.rowsByKey(rawId)[`${map}:e1`]._id as number, { data2: type, data3: label });
      await h.upload(rawId);
      expect(typeOf(h.rowsByKey(rawId)[`${map}:e1`])).toEqual([type, label]);
      expect(h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx).effect).toBe('none');
    });
  });
});

describe('contacts upload: an address edited as one line (AOSP Contacts)', () => {
  const munich = () => ({
    name: { full: 'Maria Muster' },
    addresses: {
      home: {
        contexts: { private: true },
        coordinates: 'geo:48.137,11.575',
        components: [
          { kind: 'name', value: 'Marienplatz 1' },
          { kind: 'postcode', value: '80331' },
          { kind: 'locality', value: 'Munich' },
          { kind: 'region', value: 'Bavaria' },
          { kind: 'country', value: 'Germany' },
        ],
      },
    },
  });
  const LINE = 'Marienplatz 1, 80331 Munich, Bavaria, Germany';

  /** AOSP writes the formatted address alone; the provider keeps it in STREET and empties the other parts. */
  async function editLine(line: string) {
    const h = new Harness();
    const { id, rawId } = await h.seed(munich());
    const row = h.rowsByKey(rawId)['addresses:home'];
    expect(row.data1).toBe(LINE);
    h.device.user.updateData(row._id as number, { data1: line, data4: null, data5: null, data6: null, data7: null, data8: null, data9: null, data10: null });
    expect(h.rowsByKey(rawId)['addresses:home']).toMatchObject({ data1: line, data4: line, data7: null });
    return { h, id, rawId };
  }

  async function patchOf(h: Harness, rawId: number): Promise<PatchObject> {
    const plan = h.planner.planUpload(await h.contact(rawId), h.ctx);
    if (plan.kind !== 'upload' || plan.actions[0].kind !== 'update') throw new Error(`expected an update, got ${plan.kind}`);
    return plan.actions[0].patch;
  }

  const components = (street: string, locality = 'Munich', postcode = '80331') => [
    { kind: 'name', value: street },
    { kind: 'postcode', value: postcode },
    { kind: 'locality', value: locality },
    { kind: 'region', value: 'Bavaria' },
    { kind: 'country', value: 'Germany' },
  ];

  it('reads the parts back from the new line, so `full` and the components agree', async () => {
    const line = 'Industrieweg 42, 80331 Augsburg, Bavaria, Germany';
    const { h, id, rawId } = await editLine(line);
    expect(await patchOf(h, rawId)).toEqual({
      'addresses/home/components': components('Industrieweg 42', 'Augsburg'),
      'addresses/home/full': line,
    });
    await h.upload(rawId);
    expect(h.card(id).addresses!.home).toEqual({
      contexts: { private: true }, coordinates: 'geo:48.137,11.575', isOrdered: true, full: line,
      components: components('Industrieweg 42', 'Augsburg'),
    });
    // The device gets its parts back and settles.
    expect(h.rowsByKey(rawId)['addresses:home']).toMatchObject({ data1: line, data4: 'Industrieweg 42', data7: 'Augsburg', data9: '80331' });
    const local = await h.contact(rawId);
    expect(local.dirty).toBe(false);
    expect(h.planner.planDownload(h.card(id), local, h.ctx).effect).toBe('none');
  });

  it('changes only the part whose words changed', async () => {
    const { h, rawId } = await editLine('Marienplatz 2, 80331 Munich, Bavaria, Germany');
    expect(await patchOf(h, rawId)).toEqual({
      'addresses/home/components': components('Marienplatz 2'),
      'addresses/home/full': 'Marienplatz 2, 80331 Munich, Bavaria, Germany',
    });
  });

  it('keeps the whole line as the street when the change can not be pinned to one part', async () => {
    const line = 'Industrieweg 42, 86150 Augsburg, Bavaria, Germany';
    const { h, id, rawId } = await editLine(line);
    expect(await patchOf(h, rawId)).toEqual({ 'addresses/home/components': [{ kind: 'name', value: line }], 'addresses/home/full': line });
    await h.upload(rawId);
    expect(h.card(id).addresses!.home).toMatchObject({ contexts: { private: true }, coordinates: 'geo:48.137,11.575', full: line, components: [{ kind: 'name', value: line }] });
    const local = await h.contact(rawId);
    expect(local.dirty).toBe(false);
    expect(h.planner.planDownload(h.card(id), local, h.ctx).effect).toBe('none');
  });

  it('uploads nothing for the same line saved again', async () => {
    const { h, rawId } = await editLine(LINE);
    expect(h.planner.planUpload(await h.contact(rawId), h.ctx).kind).toBe('clean');
  });

  it('reads the parts back from a line an editor re-inserted without its key', async () => {
    const line = 'Marienplatz 1, 80331 Munich, Upper Bavaria, Germany';
    const h = new Harness();
    const { rawId } = await h.seed(munich());
    h.device.user.fossifySave(rawId, null, [{ [Data.MIMETYPE]: MimeType.STRUCTURED_POSTAL, data1: line, data2: 1 }]);
    expect(await patchOf(h, rawId)).toEqual({
      'addresses/home/components': components('Marienplatz 1').map((c) => (c.kind === 'region' ? { ...c, value: 'Upper Bavaria' } : c)),
      'addresses/home/full': line,
    });
  });

  it('edits the parts an editor kept as parts, whatever its line says', async () => {
    const line = 'Marienplatz 1, 80331 Augsburg, Bavaria, Germany';
    const h = new Harness();
    const { rawId } = await h.seed(munich());
    h.device.user.updateData(h.rowsByKey(rawId)['addresses:home']._id as number, { data7: 'Augsburg', data1: line });
    expect(await patchOf(h, rawId)).toEqual({ 'addresses/home/components': components('Marienplatz 1', 'Augsburg'), 'addresses/home/full': line });
  });
});

describe('contacts upload: the name', () => {
  const NAME_KEY = 'name';

  it('re-derives a derived `full` when a component changes (and the provider recomputed the display name)', async () => {
    const { patch } = await editedPatch(probeCard, NAME_KEY, { data2: 'Probert', data1: 'Dr. Probert Person' });
    expect(patch).toEqual({
      'name/components': [
        { kind: 'title', value: 'Dr.' },
        { kind: 'given', value: 'Probert', phonetic: 'Proob' },
        { kind: 'surname', value: 'Person' },
      ],
      'name/full': 'Dr. Probert Person',
    });
  });

  it('uploads a typed display name as `full` alone', async () => {
    const { patch } = await editedPatch(probeCard, NAME_KEY, { data1: 'Probe P.' });
    expect(patch).toEqual({ 'name/full': 'Probe P.' });
  });

  it('leaves a custom `full` alone when only components change', async () => {
    const { patch } = await editedPatch(googleCard, NAME_KEY, { data3: 'Gross', data1: 'Prof. Günther Karl Gross, PhD' });
    expect(patch).toEqual({
      'name/components': [
        { kind: 'title', value: 'Prof.' },
        { kind: 'given', value: 'Günther' },
        { kind: 'given2', value: 'Karl' },
        { kind: 'surname', value: 'Gross' },
        { kind: 'credential', value: 'PhD' },
      ],
    });
  });

  it('adds a component the name did not have in display order', async () => {
    const { patch } = await editedPatch(appleCard, NAME_KEY, { data5: 'Maria', data1: 'Anna Maria Apfel' });
    expect(patch).toEqual({
      'name/components': [{ kind: 'given', value: 'Anna' }, { kind: 'given2', value: 'Maria' }, { kind: 'surname', value: 'Apfel' }],
      'name/full': 'Anna Maria Apfel',
    });
  });

  it('removes a component whose column was emptied', async () => {
    const { patch } = await editedPatch(probeCard, NAME_KEY, { data4: null, data1: 'Probe Person' });
    expect(patch['name/components']).toEqual([{ kind: 'given', value: 'Probe', phonetic: 'Proob' }, { kind: 'surname', value: 'Person' }]);
    expect(patch['name/full']).toBe('Probe Person');
  });

  it('uploads a phonetic name as the component phonetic', async () => {
    const { patch } = await editedPatch(probeCard, NAME_KEY, { data9: 'Pörson' });
    expect(patch).toEqual({
      'name/components': [
        { kind: 'title', value: 'Dr.' },
        { kind: 'given', value: 'Probe', phonetic: 'Proob' },
        { kind: 'surname', value: 'Person', phonetic: 'Pörson' },
      ],
    });
  });

  it('uploads a retyped name the server holds as `full` alone whole: `full` and every component', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed({ name: { full: 'Ada' } });
    // A typed display name: the provider splits it (the fake does so when no component is given).
    h.device.user.updateData(h.rowsByKey(rawId).name._id as number, { data1: 'Ada King', data2: null, data3: null, data4: null, data5: null, data6: null });
    expect(h.rowsByKey(rawId).name).toMatchObject({ data1: 'Ada King', data2: 'Ada', data3: 'King' });
    const plan = h.planner.planUpload(await h.contact(rawId), h.ctx);
    expect(plan).toMatchObject({
      kind: 'upload',
      actions: [{ patch: { 'name/components': [{ kind: 'given', value: 'Ada' }, { kind: 'surname', value: 'King' }], 'name/full': 'Ada King' } }],
    });
    await h.upload(rawId);
    expect(h.card(id).name).toMatchObject({ full: 'Ada King', components: [{ kind: 'given', value: 'Ada' }, { kind: 'surname', value: 'King' }] });
    const local = await h.contact(rawId);
    expect(local.dirty).toBe(false);
    expect(h.rowsByKey(rawId).name).toMatchObject({ data1: 'Ada King', data2: 'Ada', data3: 'King' });
    expect(h.planner.planDownload(h.card(id), local, h.ctx).effect).toBe('none');
  });

  it('re-derives a derived `full` when a retyped display name adds a component', async () => {
    const h = new Harness();
    const { id, rawId } = await h.seed({ name: { components: [{ kind: 'given', value: 'Ada' }], full: 'Ada' } });
    h.device.user.updateData(h.rowsByKey(rawId).name._id as number, { data1: 'Ada King', data2: null, data3: null, data4: null, data5: null, data6: null });
    await h.upload(rawId);
    expect(h.card(id).name).toMatchObject({ full: 'Ada King', components: [{ kind: 'given', value: 'Ada' }, { kind: 'surname', value: 'King' }] });
  });

  it('drops surname2 only when the family name changed', async () => {
    const card = () => ({ name: { components: [{ kind: 'given', value: 'Ana' }, { kind: 'surname', value: 'García' }, { kind: 'surname2', value: 'López' }], full: 'Ana García López' } });
    const h = new Harness();
    const { rawId } = await h.seed(card());
    expect(h.rowsByKey(rawId).name.data3).toBe('García López');
    const { patch } = await editedPatch(card, NAME_KEY, { data3: 'García Pérez', data1: 'Ana García Pérez' });
    expect(patch['name/components']).toEqual([{ kind: 'given', value: 'Ana' }, { kind: 'surname', value: 'García Pérez' }]);
  });
});

describe('contacts upload: nothing mapped changed', () => {
  it.each([['probe', probeCard], ['apple', appleCard], ['google', googleCard]])('clears DIRTY without a request for a starred %s card', async (_n, make) => {
    const h = new Harness();
    const { rawId } = await h.seed(make());
    const before = JSON.stringify(h.device.rows('data', 'raw_contact_id = ?', [rawId]));
    h.device.user.star(rawId);
    const plan = h.planner.planUpload(await h.contact(rawId), h.ctx);
    expect(plan.kind).toBe('clean');
    if (plan.kind !== 'clean') return;
    expect(plan.ops.ops.filter((o) => o.op !== 'assert' && o.op !== 'syncState' && o.table === 'data')).toEqual([]);
    await h.applyOk(plan.ops);
    expect(h.dirty(rawId)).toBe(false);
    expect(JSON.stringify(h.device.rows('data', 'raw_contact_id = ?', [rawId]))).toBe(before);
  });

  it('never uploads IS_PRIMARY of a row an editor re-inserted', async () => {
    const h = new Harness();
    const { rawId } = await h.seed(appleCard());
    const rows = h.rowsByKey(rawId);
    h.device.user.deleteData(rows['emails:k1']._id as number);
    h.device.user.insertData(rawId, { [Data.MIMETYPE]: MimeType.EMAIL, [Data.DATA1]: 'anna@example.com', [Data.DATA2]: 1, is_primary: 0 });
    expect(h.planner.planUpload(await h.contact(rawId), h.ctx).kind).toBe('clean');
  });
});
