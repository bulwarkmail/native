import { describe, expect, it } from 'vitest';
import { Data, EmailType, MimeType, PhoneType, RelationType, WebsiteType } from '../../android-columns';
import { contactsPlanner } from '../../contacts/planner';
import { entryKey, orgKey, parseEntryKey, parseOrgKey } from '../../contacts/keys';
import { editPostalComponents, postalCells, resplitPostal } from '../../contacts/postal';
import { base64ToBytes, dataUriBase64, shadowOf } from '../../contacts/photo';
import { fullIsDerived, nameCells } from '../../contacts/name';
import { emailType, phoneFlags, phoneType, relationName, relationType, websiteType } from '../../contacts/types-map';
import type { ContactCardWire } from '../../planner';
import { JPEG } from './fixtures';

describe('contacts decode', () => {
  it('queries the columns the planner reads', () => {
    expect(contactsPlanner.rawContactColumns).toEqual(expect.arrayContaining([
      '_id', 'sourceid', 'version', 'dirty', 'deleted', 'sync1', 'sync2', 'sync3', 'sync4',
    ]));
    // The providers refuse it in every projection ("Invalid column"): it is only written.
    expect(contactsPlanner.rawContactColumns).not.toContain('raw_contact_is_read_only');
    expect(contactsPlanner.dataColumns).toEqual(expect.arrayContaining([
      '_id', 'raw_contact_id', 'mimetype', 'is_primary', 'data1', 'data14', 'data_sync1', 'data_sync2', 'data_sync3', 'group_sourceid',
    ]));
    expect(contactsPlanner.dataColumns).not.toContain('data15');
    expect(contactsPlanner.groupColumns).toEqual(expect.arrayContaining(['_id', 'sourceid', 'version', 'dirty', 'deleted', 'title', 'sync2', 'sync3', 'sync4']));
  });

  it('reads numbers given as text (data columns are TEXT) and tolerates what other apps left in sync columns', () => {
    const local = contactsPlanner.decodeContact(
      { _id: '5', sourceid: 'c/e1', version: '3', dirty: '1', deleted: null, sync1: 'c/b,garbage,,c/x', sync2: '{"not":"a card"}', sync3: '{"uid":1}', sync4: 'nope' },
      [
        { _id: '9', raw_contact_id: '5', mimetype: MimeType.EMAIL, data1: 'a@b', data2: '2', data_sync1: 'emails:e1', data_sync2: '', data_sync3: '[1]' },
        { _id: 10, raw_contact_id: 6, mimetype: MimeType.NOTE, data1: 'another contact' },
      ],
    );
    expect(local).toMatchObject({
      rawContactId: 5, sourceId: 'c/e1', version: 3, dirty: true, deleted: false,
      collections: ['c/b', 'c/x'], shadow: null, pending: null, poison: null,
    });
    expect(local.rows).toEqual([{ id: 9, mimetype: MimeType.EMAIL, cells: { data1: 'a@b', data2: '2' }, key: 'emails:e1', photoHash: null, baseline: null }]);
  });

  it('decodes a pending create, a poison marker and a group', () => {
    const local = contactsPlanner.decodeContact({
      _id: 1, sourceid: null, version: 1, dirty: 1, deleted: 0,
      sync3: JSON.stringify({ uid: 'urn:uuid:x', target: 'c/b' }),
      sync4: JSON.stringify({ fp: 'f', type: 'invalidProperties', n: 2, until: 5 }),
    }, []);
    expect(local.pending).toEqual({ uid: 'urn:uuid:x', target: 'c/b' });
    expect(local.poison).toEqual({ fp: 'f', type: 'invalidProperties', n: 2, until: 5 });
    expect(contactsPlanner.decodeGroup({ _id: 4, sourceid: 'c/g', version: 2, dirty: 0, deleted: 1, title: 'T', sync2: '{"id":"g","kind":"group"}' }))
      .toMatchObject({ groupId: 4, sourceId: 'c/g', deleted: true, title: 'T', shadow: { id: 'g', kind: 'group' } });
  });
});

describe('contacts keys', () => {
  it('round-trips entry keys with any character', () => {
    for (const key of ['work1', 'x/y', 'a,b|c%d', 'urn:uuid:1', 'k:1']) {
      expect(parseEntryKey(entryKey('emails', key))).toEqual({ map: 'emails', key });
    }
    expect(parseEntryKey('name')).toBeNull();
    expect(parseEntryKey('garbage')).toBeNull();
  });

  it('round-trips organization keys, titles positional as title then role', () => {
    expect(orgKey({ org: 'o1', title: 't1', role: 'r1' })).toBe('organizations:o1|titles:t1,r1');
    expect(orgKey({ org: null, title: null, role: 'r1' })).toBe('titles:,r1');
    expect(orgKey({ org: 'o1', title: null, role: null })).toBe('organizations:o1');
    for (const parts of [{ org: 'o|1', title: 't,1', role: null }, { org: null, title: 't1', role: 'r1' }, { org: 'o', title: null, role: null }]) {
      expect(parseOrgKey(orgKey(parts))).toEqual(parts);
    }
    expect(parseOrgKey('emails:e1')).toBeNull();
  });
});

describe('contacts type tables', () => {
  it.each([
    [{ features: { mobile: true }, contexts: { work: true } }, PhoneType.WORK_MOBILE],
    [{ features: { cell: true } }, PhoneType.MOBILE],
    [{ features: { fax: true }, contexts: { private: true } }, PhoneType.FAX_HOME],
    [{ features: { fax: true } }, PhoneType.OTHER_FAX],
    [{ features: { pager: true }, contexts: { work: true } }, PhoneType.WORK_PAGER],
    [{ features: { textphone: true } }, PhoneType.TTY_TDD],
    [{ features: { 'main-number': true } }, PhoneType.MAIN],
    [{ features: { voice: true }, contexts: { work: true } }, PhoneType.WORK],
    [{ contexts: { private: true } }, PhoneType.HOME],
    [{ features: { video: true } }, PhoneType.OTHER],
    [{ features: { mobile: true }, label: 'Boat' }, PhoneType.CUSTOM],
  ])('phone %j → TYPE %i', (entry, type) => {
    expect(phoneType(entry).type).toBe(type);
  });

  it('reads the phone table right to left, OTHER meaning no features', () => {
    expect(phoneFlags(PhoneType.OTHER, null)).toEqual({ contexts: [], features: [], label: null });
    expect(phoneFlags(PhoneType.FAX_WORK, null)).toEqual({ contexts: ['work'], features: ['fax'], label: null });
    expect(phoneFlags(PhoneType.CAR, null)).toEqual({ contexts: [], features: ['voice'], label: 'car' });
  });

  it('reads back the types RFC 9553 lacks from the label they upload with', () => {
    expect(phoneType({ features: { 'main-number': true }, contexts: { work: true } }).type).toBe(PhoneType.COMPANY_MAIN);
    expect(phoneType({ features: { voice: true }, label: 'car' })).toEqual({ type: PhoneType.CAR, label: null });
    expect(phoneType({ features: { text: true }, label: 'mms' })).toEqual({ type: PhoneType.MMS, label: null });
    // A custom label uploads without the feature, so it stays custom; a lone `text` is no MMS.
    expect(phoneType({ label: 'car' })).toEqual({ type: PhoneType.CUSTOM, label: 'car' });
    expect(phoneType({ features: { text: true } }).type).toBe(PhoneType.OTHER);
    expect(emailType({ label: 'mobile' })).toEqual({ type: EmailType.MOBILE, label: null });
    expect(websiteType({ label: 'blog', contexts: { work: true } })).toEqual({ type: WebsiteType.BLOG, label: null });
  });

  it('maps relations both ways, device-only types to the nearest RFC type', () => {
    expect(relationType({ friend: true })).toEqual({ type: RelationType.FRIEND, label: null });
    expect(relationType({ 'co-worker': true })).toEqual({ type: RelationType.CUSTOM, label: 'co-worker' });
    expect(relationType({ agent: true })).toEqual({ type: RelationType.ASSISTANT, label: null });
    expect(relationName(RelationType.BROTHER, null)).toBe('sibling');
    expect(relationName(RelationType.REFERRED_BY, null)).toBe('contact');
    expect(relationName(RelationType.CUSTOM, 'Emergency')).toBe('emergency');
  });
});

describe('contacts name and postal helpers', () => {
  it('fills the family name from surname and surname2, the suffix from the first of its kinds, and a missing `full` with deriveFullName', () => {
    // deriveFullName (the app's) leaves out surname2 and credential.
    expect(nameCells({ components: [{ kind: 'surname', value: 'García' }, { kind: 'surname2', value: 'López' }, { kind: 'credential', value: 'MD' }] }))
      .toMatchObject({ data3: 'García López', data6: 'MD', data1: 'García' });
  });

  it('knows a derived `full` in the app’s and in Stalwart’s form', () => {
    const components = [{ kind: 'given', value: 'A' }, { kind: 'surname', value: 'B' }, { kind: 'surname2', value: 'C' }];
    expect(fullIsDerived({ components, full: 'A B' })).toBe(true);
    expect(fullIsDerived({ components, full: 'A B C' })).toBe(true);
    expect(fullIsDerived({ components, full: 'B, A' })).toBe(false);
  });

  it('reads the parts of a rewritten one-line address back along the old line', () => {
    // Apple's layout: street / city region postcode / country.
    const old = { data1: '1 Infinite Loop\nCupertino CA 95014\nUSA', data4: '1 Infinite Loop', data7: 'Cupertino', data8: 'CA', data9: '95014', data10: 'USA' };
    const parts = (line: string) => {
      const out = resplitPostal(old, line);
      return out && { street: out.data4, city: out.data7, region: out.data8, postcode: out.data9, country: out.data10 };
    };
    expect(parts('1 Apple Park Way\nCupertino CA 95014\nUSA')).toEqual({ street: '1 Apple Park Way', city: 'Cupertino', region: 'CA', postcode: '95014', country: 'USA' });
    expect(parts('1 Infinite Loop\nSan Jose CA 95014\nUSA')).toMatchObject({ city: 'San Jose', region: 'CA', postcode: '95014' });
    expect(parts('1 Infinite Loop\nCupertino 95014\nUSA')).toMatchObject({ city: 'Cupertino', region: null, postcode: '95014' });
    expect(parts('1 Infinite Loop, Cupertino CA 95014, USA')).toMatchObject({ street: '1 Infinite Loop', city: 'Cupertino' });
    // Two parts of one segment changed, or the layout changed: nothing to pin the words to.
    expect(parts('1 Infinite Loop\nSan Jose NV 95014\nUSA')).toBeNull();
    expect(parts('1 Infinite Loop\nCupertino CA 95014\nCalifornia\nUSA')).toBeNull();
    // An old line that isn't made of the parts (a `full` written apart from its components).
    expect(resplitPostal({ ...old, data1: 'Apple HQ, Cupertino' }, 'Apple Park, Cupertino')).toBeNull();
  });

  it('keeps separators between street parts and falls back to the legacy flat fields', () => {
    expect(postalCells({ street: 'Old Rd 1', locality: 'Town' })).toMatchObject({ data4: 'Old Rd 1', data7: 'Town' });
    const address = { components: [{ kind: 'number', value: '12' }, { kind: 'separator', value: '-' }, { kind: 'name', value: 'Rue X' }] };
    expect(postalCells(address).data4).toBe('12-Rue X');
    expect(editPostalComponents(address, { data4: 'Rue Y 3' }, new Set(['data4']))).toEqual([{ kind: 'name', value: 'Rue Y 3' }]);
  });
});

describe('contacts photos', () => {
  it('decodes base64 and data URIs, also without a media type', () => {
    expect(base64ToBytes('AAECAw==')).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(base64ToBytes('!!')).toBeNull();
    expect(dataUriBase64(`data:image/jpeg;base64,${JPEG}`)).toBe(JPEG);
    expect(dataUriBase64(`data:base64,${JPEG}`)).toBe(JPEG);
    expect(dataUriBase64('https://example.org/p.jpg')).toBeNull();
  });

  it('keeps hashes, not bytes, in the shadow and leaves blob-backed entries alone', () => {
    const card = { id: 'e1', media: { a: { kind: 'photo', uri: `data:image/jpeg;base64,${JPEG}` }, b: { kind: 'logo', blobId: 'B1' } } } as unknown as ContactCardWire;
    const shadow = shadowOf(card);
    expect((shadow.media as Record<string, { uri?: string }>).a.uri).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((shadow.media as Record<string, unknown>).b).toEqual({ kind: 'logo', blobId: 'B1' });
    expect((card.media as Record<string, { uri?: string }>).a.uri).toContain('base64');
  });
});

describe('contacts rows of kinds the planner does not map', () => {
  it('ignores them on download and upload', async () => {
    const { Harness } = await import('./harness');
    const { appleCard } = await import('./fixtures');
    const h = new Harness();
    const { id, rawId } = await h.seed(appleCard());
    h.device.user.insertData(rawId, { [Data.MIMETYPE]: 'vnd.android.cursor.item/im', data1: 'anna@jabber.example' });
    expect(h.planner.planUpload(await h.contact(rawId), h.ctx).kind).toBe('clean');
    expect(h.planner.planDownload(h.card(id), await h.contact(rawId), h.ctx).effect).toBe('none');
  });
});
