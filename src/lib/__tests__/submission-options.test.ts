import { describe, it, expect, vi } from 'vitest';

const caps = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: { getAccountCapability: vi.fn(() => caps.value) },
}));

import { hasSubmissionExtension, submissionEnvelopeParameters, supportsSubmissionExtension } from '../submission-options';
import { messagePriorityFromHeaders, messagePriorityHeaders } from '../message-priority';

describe('submissionEnvelopeParameters', () => {
  it('asks for DSN with RET=HDRS and NOTIFY on every recipient', () => {
    expect(submissionEnvelopeParameters({ requestDsn: true })).toEqual({
      mailFrom: { RET: 'HDRS' },
      rcptTo: { NOTIFY: 'SUCCESS,FAILURE,DELAY' },
    });
  });

  it('writes REQUIRETLS without a value and keeps the hold', () => {
    expect(submissionEnvelopeParameters({ requireTls: true }, 90)).toEqual({
      mailFrom: { HOLDFOR: '90', REQUIRETLS: null },
      rcptTo: {},
    });
  });

  it('adds nothing without options', () => {
    expect(submissionEnvelopeParameters(undefined)).toEqual({ mailFrom: {}, rcptTo: {} });
  });
});

describe('submission extensions', () => {
  it('reads the RFC 8621 map, any case', () => {
    expect(hasSubmissionExtension({ dsn: [], REQUIRETLS: [] }, 'DSN')).toBe(true);
    expect(hasSubmissionExtension({ FUTURERELEASE: [] }, 'DSN')).toBe(false);
    expect(hasSubmissionExtension(['DSN'], 'dsn')).toBe(true);
    expect(hasSubmissionExtension(null, 'DSN')).toBe(false);
  });

  it("offers DSN only when the account's submission capability lists it (Stalwart 0.16 and 1.0 do)", () => {
    caps.value = { submissionExtensions: { FUTURERELEASE: [], DSN: [], 'MT-PRIORITY': ['MIXER'], REQUIRETLS: [] } };
    expect(supportsSubmissionExtension('DSN')).toBe(true);
    expect(supportsSubmissionExtension('REQUIRETLS')).toBe(true);
    caps.value = { submissionExtensions: { FUTURERELEASE: [] } };
    expect(supportsSubmissionExtension('DSN')).toBe(false);
    caps.value = undefined;
    expect(supportsSubmissionExtension('DSN')).toBe(false);
  });
});

describe('message priority headers', () => {
  it('maps high and low to X-Priority and Importance, normal to nothing', () => {
    expect(messagePriorityHeaders('high')).toEqual({ 'header:X-Priority:asText': '1 (Highest)', 'header:Importance:asText': 'high' });
    expect(messagePriorityHeaders('low')).toEqual({ 'header:X-Priority:asText': '5 (Lowest)', 'header:Importance:asText': 'low' });
    expect(messagePriorityHeaders('normal')).toEqual({});
  });

  it('reads a priority back, X-Priority first', () => {
    expect(messagePriorityFromHeaders([{ name: 'x-priority', value: ' 2' }])).toBe('high');
    expect(messagePriorityFromHeaders([{ name: 'X-Priority', value: '3 (Normal)' }, { name: 'Importance', value: 'high' }])).toBe('normal');
    expect(messagePriorityFromHeaders([{ name: 'Importance', value: ' Low' }])).toBe('low');
    expect(messagePriorityFromHeaders(undefined)).toBe('normal');
  });
});
