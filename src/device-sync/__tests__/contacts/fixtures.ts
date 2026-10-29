/**
 * Server cards for the contacts planner tests. `probeCard` is what the local
 * Stalwart returned for a card created over JMAP with client keys (live probe
 * output); the others are shaped like cards synced in over CardDAV from
 * Apple and Google clients, whose keys Stalwart generates by position.
 */

/** A 1×1 JPEG. */
export const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
/** Another picture's bytes (any base64 does for the fakes). */
export const JPEG2 = '/9j/4AAQSkZJRgABAgAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

export function probeCard(): Record<string, unknown> {
  return {
    uid: 'urn:uuid:probe-1790463389675',
    kind: 'individual',
    name: {
      full: 'Dr. Probe Person',
      phoneticSystem: 'ipa',
      components: [
        { kind: 'title', value: 'Dr.' },
        { kind: 'given', value: 'Probe', phonetic: 'Proob' },
        { kind: 'surname', value: 'Person' },
      ],
      isOrdered: true,
    },
    nicknames: { nk: { name: 'Probby' } },
    emails: {
      work1: { address: 'probe@work.example', contexts: { work: true }, pref: 1, label: 'Office' },
      'x/y': { address: 'slash@example.org' },
      zz9: { address: 'private@example.org', contexts: { private: true } },
    },
    phones: {
      'p-a': { number: '+49 30 1234', contexts: { private: true }, features: { voice: true, mobile: true } },
      fax7: { number: '+49 30 9999', contexts: { work: true }, features: { fax: true } },
    },
    addresses: {
      home: {
        contexts: { private: true },
        coordinates: 'geo:52.5,13.4',
        timeZone: 'Europe/Berlin',
        countryCode: 'DE',
        full: 'Main St 12, 10115 Berlin, Germany',
        components: [
          { kind: 'name', value: 'Main St' },
          { kind: 'separator', value: ' ' },
          { kind: 'number', value: '12' },
          { kind: 'locality', value: 'Berlin' },
          { kind: 'postcode', value: '10115' },
          { kind: 'country', value: 'Germany' },
          { kind: 'apartment', value: '4b' },
        ],
        isOrdered: true,
      },
    },
    organizations: { o1: { name: 'ACME', units: [{ name: 'R&D' }] } },
    titles: {
      t1: { name: 'Chief Prober', kind: 'title', organizationId: 'o1' },
      r1: { name: 'Lead', kind: 'role', organizationId: 'o1' },
    },
    links: { l1: { uri: 'https://probe.example', contexts: { work: true } } },
    onlineServices: { im1: { uri: 'xmpp:probe@example.org', service: 'XMPP' } },
    anniversaries: {
      bday: { date: { '@type': 'PartialDate', month: 3, day: 14 }, kind: 'birth' },
      wed: { date: { '@type': 'PartialDate', year: 2010, month: 6, day: 1 }, kind: 'wedding' },
    },
    relatedTo: { 'urn:uuid:other-person': { relation: { friend: true } } },
    notes: { n1: { note: 'first note' }, n2: { note: 'second note' } },
    media: { ph: { uri: `data:image/jpeg;base64,${JPEG}`, kind: 'photo', mediaType: 'image/jpeg' } },
    keywords: { vip: true },
    personalInfo: { pi1: { value: 'probing', kind: 'hobby' } },
    preferredLanguages: { lang1: { language: 'de', pref: 1 } },
    speakToAs: { grammaticalGender: 'neuter' },
  };
}

/** Apple Contacts over CardDAV: no PROP-IDs, so `k1…kN`; an address without `full`. */
export function appleCard(): Record<string, unknown> {
  return {
    uid: 'urn:uuid:5F2C9B1E-APPLE',
    kind: 'individual',
    prodId: '-//Apple Inc.//iPhone OS 18.0//EN',
    name: {
      components: [{ kind: 'given', value: 'Anna' }, { kind: 'surname', value: 'Apfel' }],
      isOrdered: true,
      full: 'Anna Apfel',
    },
    emails: {
      k1: { address: 'anna@example.com', contexts: { private: true }, pref: 1 },
      k2: { address: 'anna@work.example', contexts: { work: true } },
    },
    phones: {
      k1: { number: '+1 555 0100', features: { mobile: true, voice: true } },
      k2: { number: '+1 555 0101', contexts: { work: true }, features: { voice: true } },
      k3: { number: '+1 555 0102', contexts: { work: true }, features: { fax: true } },
    },
    addresses: {
      k1: {
        components: [
          { kind: 'name', value: '1 Infinite Loop' },
          { kind: 'locality', value: 'Cupertino' },
          { kind: 'region', value: 'CA' },
          { kind: 'postcode', value: '95014' },
          { kind: 'country', value: 'USA' },
        ],
        isOrdered: true,
        contexts: { work: true },
      },
    },
    anniversaries: { k1: { kind: 'birth', date: { '@type': 'PartialDate', year: 1980, month: 5, day: 4 } } },
    notes: { k1: { note: 'Met at WWDC' } },
    onlineServices: { k1: { service: 'Skype', user: 'anna.apfel' } },
    keywords: { friends: true },
  };
}

/** Google Contacts over CardDAV: a legacy `cell` feature, a custom display name, two nicknames. */
export function googleCard(): Record<string, unknown> {
  return {
    uid: 'google-8a7d2f',
    kind: 'individual',
    name: {
      components: [
        { kind: 'title', value: 'Prof.' },
        { kind: 'given', value: 'Günther' },
        { kind: 'given2', value: 'Karl' },
        { kind: 'surname', value: 'Groß' },
        { kind: 'credential', value: 'PhD' },
      ],
      isOrdered: true,
      full: 'Groß, Günther',
    },
    nicknames: { k1: { name: 'Gü' }, k2: { name: 'GKG' } },
    phones: { k1: { number: '0171 2345678', features: { cell: true } } },
    links: { k1: { uri: 'https://example.org/~guenther', label: 'profile' } },
    organizations: { k1: { name: 'Uni Beispiel', units: [{ name: 'Informatik' }, { name: 'AG Sync' }] } },
    titles: { k1: { name: 'Professor', kind: 'title', organizationId: 'k1' } },
    relatedTo: { 'Maria Groß': { relation: { spouse: true } } },
    anniversaries: { k1: { kind: 'wedding', date: { '@type': 'PartialDate', month: 8, day: 15 } } },
    speakToAs: { grammaticalGender: 'masculine' },
  };
}
