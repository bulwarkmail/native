import { describe, expect, it } from 'vitest';
import {
  LabelRequiredError,
  applyLabelPrefix,
  classifyOutgoing,
  draftLabelChoice,
  draftLabelProperty,
  labelHeaderLines,
  labelHeaderProperties,
  labelMissing,
  labelSourceHeaders,
  labelsPolicyOf,
  parseSioLabelMarking,
  receivedLabel,
  resolveLabel,
  sioLabelValue,
  textColorOn,
  type ClassificationLabel,
  type LabelsPolicy,
} from '../classification-labels';
import { resolvePolicy, sanitizePolicy } from '../org-policy';

// Classification labels (webmail lib/classification/labels.ts and
// lib/outgoing/classification.ts; its lib/__tests__/classification-labels.test.ts
// cases): the headers a label writes, reading them back, the subject prefix,
// the draft marker, and what the policy's labels section allows.

const label = (l: Partial<ClassificationLabel> & Pick<ClassificationLabel, 'id' | 'name' | 'color' | 'marking'>): ClassificationLabel => ({
  description: '', sensitivity: '', subjectPrefix: '', extraHeaderValue: '', ...l,
});

const generic = [
  label({ id: 'public', name: 'Public', color: '#16a34a', marking: 'PUBLIC', extraHeaderValue: 'Public' }),
  label({ id: 'internal', name: 'Internal', color: '#2563eb', marking: 'INTERNAL', extraHeaderValue: 'Internal' }),
  label({
    id: 'confidential', name: 'Confidential', color: '#d97706', marking: 'CONFIDENTIAL', sensitivity: 'Company-Confidential',
    subjectPrefix: '[Confidential]', extraHeaderValue: 'Confidential',
  }),
  label({
    id: 'strictly-confidential', name: 'Strictly confidential', color: '#dc2626', marking: 'STRICTLY CONFIDENTIAL',
    sensitivity: 'Company-Confidential', subjectPrefix: '[Strictly confidential]', extraHeaderValue: 'Strictly confidential',
  }),
];
const german = [
  label({ id: 'offen', name: 'OFFEN', color: '#6b7280', marking: 'OFFEN', extraHeaderValue: 'OFFEN' }),
  label({
    id: 'vs-nfd', name: 'VS-NfD', color: '#b91c1c', marking: 'VS-NUR FÜR DEN DIENSTGEBRAUCH', sensitivity: 'Company-Confidential',
    subjectPrefix: 'VS-NfD', extraHeaderValue: 'VS-NfD',
  }),
];
const byId = (list: ClassificationLabel[], id: string) => list.find((l) => l.id === id)!;
const confidential = byId(generic, 'confidential');
const vsnfd = byId(german, 'vs-nfd');
const policy: LabelsPolicy = { list: generic, defaultId: 'internal', required: false, extraHeader: 'X-Classification' };

describe('SIO-Label', () => {
  it('writes an ASCII marking quoted, with readable colours', () => {
    expect(sioLabelValue(confidential)).toBe(' marking="CONFIDENTIAL"; fgcolor=#000000; bgcolor=#d97706');
    expect(textColorOn('#1e3a8a')).toBe('#ffffff');
    expect(textColorOn('#fde68a')).toBe('#000000');
  });

  it('writes a non-ASCII marking with RFC 2231, folded under 78 columns, and reads it back', () => {
    const value = sioLabelValue(vsnfd);
    expect(value).toContain("marking*=utf-8''VS-NUR%20F%C3%9CR%20DEN%20DIENSTGEBRAUCH;");
    expect(value).not.toContain('=?');
    for (const l of `SIO-Label:${value}`.split('\r\n')) expect(l.length).toBeLessThanOrEqual(78);
    expect(parseSioLabelMarking(value)).toBe('VS-NUR FÜR DEN DIENSTGEBRAUCH');
  });

  it('continues a long encoded marking over several parameters and reads it back', () => {
    const long = { ...vsnfd, marking: 'ÄÖÜ äöü ß – sehr lange Kennzeichnung für einen Test der Fortsetzung' };
    const value = sioLabelValue(long);
    expect(value).toMatch(/marking\*0\*=utf-8''/);
    expect(value).toMatch(/marking\*1\*=/);
    expect(parseSioLabelMarking(value)).toBe(long.marking);
  });

  it('reads the forms servers hand back', () => {
    expect(parseSioLabelMarking(' marking="INTERNAL"; fgcolor=#ffffff; bgcolor=#2563eb')).toBe('INTERNAL');
    expect(parseSioLabelMarking(' marking="STRICTLY\r\n CONFIDENTIAL"; bgcolor=red')).toBe('STRICTLY CONFIDENTIAL');
    expect(parseSioLabelMarking('marking=PUBLIC;fgcolor=black')).toBe('PUBLIC');
    expect(parseSioLabelMarking(' marking="=?UTF-8?B?VlMtTlVSIEbDnFIgREVOIERJRU5TVEdFQlJBVUNI?="')).toBe('VS-NUR FÜR DEN DIENSTGEBRAUCH');
    expect(parseSioLabelMarking(undefined)).toBeNull();
  });

  it('writes Sensitivity and the extra header only when the label sets them', () => {
    expect(labelHeaderProperties(confidential, 'X-Classification')).toEqual({
      'header:SIO-Label:asRaw': 'marking="CONFIDENTIAL"; fgcolor=#000000; bgcolor=#d97706',
      'header:Sensitivity:asText': 'Company-Confidential',
      'header:X-Classification:asText': 'Confidential',
    });
    expect(Object.keys(labelHeaderProperties(byId(generic, 'public'), ''))).toEqual(['header:SIO-Label:asRaw']);
    expect(labelHeaderLines(vsnfd, 'X-Classification')).toEqual([
      `SIO-Label:${sioLabelValue(vsnfd)}`,
      'Sensitivity: Company-Confidential',
      'X-Classification: VS-NfD',
    ]);
    expect(labelHeaderLines({ ...vsnfd, extraHeaderValue: 'Geheim für alle' }, 'X-Class')[2]).toMatch(/^X-Class: =\?UTF-8\?B\?/);
  });
});

describe('received labels', () => {
  it('are matched by marking first, from the JMAP header list', () => {
    expect(receivedLabel([{ name: 'SIO-Label', value: ' marking="confidential "' }], policy)?.id).toBe('confidential');
    expect(receivedLabel([{ name: 'sio-label', value: ' marking="PUBLIC"' }], policy)?.id).toBe('public');
  });

  it('then by the extra header value', () => {
    expect(receivedLabel([{ name: 'X-Classification', value: ' Strictly confidential' }], policy)?.id).toBe('strictly-confidential');
  });

  it('show nothing for an unknown marking or without labels', () => {
    expect(receivedLabel([{ name: 'SIO-Label', value: ' marking="TOP SECRET"' }], policy)).toBeNull();
    expect(receivedLabel([{ name: 'SIO-Label', value: ' marking="PUBLIC"' }], { ...policy, list: [] })).toBeNull();
  });
});

describe('the subject prefix', () => {
  const strictly = byId(generic, 'strictly-confidential');

  it('is added once, and not doubled across reply chains', () => {
    expect(applyLabelPrefix('Budget', confidential, generic)).toBe('[Confidential] Budget');
    expect(applyLabelPrefix('[Confidential] Budget', confidential, generic)).toBe('[Confidential] Budget');
    expect(applyLabelPrefix('Re: [Confidential] Budget', confidential, generic)).toBe('[Confidential] Re: Budget');
    expect(applyLabelPrefix('AW: WG: [Confidential] Re: [Confidential] Budget', confidential, generic)).toBe('[Confidential] AW: WG: Re: Budget');
  });

  it('changes with the label, and goes with no label', () => {
    expect(applyLabelPrefix('Re: [Confidential] Budget', strictly, generic)).toBe('[Strictly confidential] Re: Budget');
    expect(applyLabelPrefix('[Confidential] Re: Budget', null, generic)).toBe('Re: Budget');
  });

  it('knows prefixes without brackets', () => {
    expect(applyLabelPrefix('AW: VS-NfD Lagebericht', vsnfd, german)).toBe('VS-NfD AW: Lagebericht');
    expect(applyLabelPrefix('VS-NfDx test', vsnfd, german)).toBe('VS-NfD VS-NfDx test');
  });
});

describe('drafts', () => {
  it('keep the pick, "none" and nothing apart', () => {
    expect(draftLabelProperty('confidential')).toEqual({ 'header:X-Bulwark-Label:asText': 'confidential' });
    expect(draftLabelProperty(null)).toEqual({ 'header:X-Bulwark-Label:asText': 'none' });
    expect(draftLabelProperty(undefined)).toEqual({});
    expect(draftLabelChoice([{ name: 'X-Bulwark-Label', value: ' confidential' }])).toBe('confidential');
    expect(draftLabelChoice([{ name: 'x-bulwark-label', value: 'none' }])).toBeNull();
    expect(draftLabelChoice([])).toBeUndefined();
  });

  it('carry only the label headers into the composer', () => {
    expect(labelSourceHeaders([
      { name: 'Received', value: 'from a by b' },
      { name: 'SIO-Label', value: ' marking="PUBLIC"' },
      { name: 'X-Bulwark-Label', value: 'public' },
    ])).toEqual([{ name: 'SIO-Label', value: ' marking="PUBLIC"' }, { name: 'X-Bulwark-Label', value: 'public' }]);
    expect(labelSourceHeaders([{ name: 'Received', value: 'x' }])).toBeUndefined();
  });
});

describe('choosing the label', () => {
  it('takes the pick, then the original\'s label from an internal sender, then the default', () => {
    expect(resolveLabel(policy, 'public')?.id).toBe('public');
    expect(resolveLabel(policy, null)).toBeNull();
    expect(resolveLabel(policy, undefined)?.id).toBe('internal');
    const original = { headers: [{ name: 'SIO-Label', value: ' marking="CONFIDENTIAL"' }], senderInternal: true };
    expect(resolveLabel(policy, undefined, original)?.id).toBe('confidential');
    // Anyone outside can write the header.
    expect(resolveLabel(policy, undefined, { ...original, senderInternal: false })?.id).toBe('internal');
    // Never one below the default.
    expect(resolveLabel(policy, undefined, { headers: [{ name: 'SIO-Label', value: ' marking="PUBLIC"' }], senderInternal: true })?.id).toBe('internal');
    // A pick that isn't in the list counts as nothing picked.
    expect(resolveLabel(policy, 'gone')?.id).toBe('internal');
  });

  it('refuses a send without a label when one is required', () => {
    const required = { ...policy, defaultId: '', required: true };
    expect(labelMissing(required, resolveLabel(required, undefined))).toBe(true);
    expect(() => classifyOutgoing(required, null, 'Hi')).toThrow(LabelRequiredError);
    expect(labelMissing(required, confidential)).toBe(false);
  });

  it('prefixes the subject and writes the headers on a send', () => {
    expect(classifyOutgoing(policy, confidential, 'Re: Budget')).toEqual({
      subject: '[Confidential] Re: Budget',
      headers: labelHeaderProperties(confidential, 'X-Classification'),
      headerLines: labelHeaderLines(confidential, 'X-Classification'),
    });
    expect(classifyOutgoing({ ...policy, list: [] }, null, 'Hi')).toEqual({ subject: 'Hi' });
  });
});

describe('the policy section', () => {
  it('drops broken labels, a default not in the list, a reserved extra header and "required" without labels', () => {
    expect(labelsPolicyOf({
      labels: {
        list: [{ id: 'a', name: 'A', color: 'red', marking: 'A"\\B', sensitivity: 'Secret' }, { id: 'a', name: 'dup' }, { name: 'no id' }],
        defaultId: 'missing', required: true, extraHeader: 'Subject',
      },
    })).toEqual({
      list: [{ id: 'a', name: 'A', color: '#6b7280', description: '', marking: 'AB', sensitivity: '', subjectPrefix: '', extraHeaderValue: '' }],
      defaultId: '', required: true, extraHeader: '',
    });
    expect(labelsPolicyOf({ labels: { list: [], required: true } }).required).toBe(false);
    expect(labelsPolicyOf(undefined).list).toEqual([]);
  });

  it('is replaced as a whole by a scope that sets it', () => {
    const raw = sanitizePolicy({
      organisation: { labels: { list: generic, defaultId: 'internal', required: true, extraHeader: 'X-Classification' } },
      scopes: [{ id: 'g', match: { groups: ['legal@example.com'] }, policy: { organisation: { labels: { list: german } } } }],
    })!;
    const scoped = labelsPolicyOf(resolvePolicy(raw, { email: 'a@example.com', groups: ['legal@example.com'] }).organisation);
    expect(scoped).toEqual({ list: german, defaultId: '', required: false, extraHeader: '' });
  });
});
