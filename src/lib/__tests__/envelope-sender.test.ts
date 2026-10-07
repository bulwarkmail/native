import { describe, it, expect } from 'vitest';
import { envelopeFallbackIdentity, overrideEnvelope, pickSubmissionIdentity } from '../envelope-sender';
import type { Identity } from '../../api/types';

const me: Identity = { id: 'main', name: 'Me', email: 'me@example.com', mayDelete: false };
const info: Identity = { id: 'info', name: 'Info', email: 'Info@example.com', mayDelete: true };
const infoTwin: Identity = { id: 'info-2', name: 'Info 2', email: 'info@example.com', mayDelete: true };
const wildcard: Identity = { id: 'wild', name: 'Any', email: '*@example.com', mayDelete: true };
const identities = [me, info, infoTwin, wildcard];

describe('pickSubmissionIdentity', () => {
  it('sends through the identity that owns the override address, in any case', () => {
    expect(pickSubmissionIdentity(identities, me, ' INFO@example.com ').id).toBe('info');
  });

  it('keeps the selected identity when it owns the address itself', () => {
    expect(pickSubmissionIdentity(identities, infoTwin, 'info@example.com').id).toBe('info-2');
  });

  it('keeps the selected identity when nobody owns the override, or there is none', () => {
    expect(pickSubmissionIdentity(identities, me, 'alias@example.com').id).toBe('main');
    expect(pickSubmissionIdentity(identities, me, undefined).id).toBe('main');
    expect(pickSubmissionIdentity(identities, me, '   ').id).toBe('main');
  });

  it('never matches a wildcard identity by its pattern', () => {
    expect(pickSubmissionIdentity(identities, me, '*@example.com').id).toBe('main');
  });
});

describe('envelopeFallbackIdentity', () => {
  it('names the identity address when the override is not an identity of the account', () => {
    expect(envelopeFallbackIdentity(identities, me, 'alias@example.com')).toBe('me@example.com');
  });

  it('is null when an identity owns the override, without an override, or for a wildcard identity', () => {
    expect(envelopeFallbackIdentity(identities, me, 'info@EXAMPLE.com')).toBeNull();
    expect(envelopeFallbackIdentity(identities, me, 'ME@example.com')).toBeNull();
    expect(envelopeFallbackIdentity(identities, me, '')).toBeNull();
    expect(envelopeFallbackIdentity(identities, me, null)).toBeNull();
    // The server derives MAIL FROM from the header From there: no fallback.
    expect(envelopeFallbackIdentity(identities, wildcard, 'alias@example.com')).toBeNull();
  });
});

describe('overrideEnvelope', () => {
  it('asks for the override as MAIL FROM with the identity as the fallback', () => {
    expect(overrideEnvelope(identities, me, ' alias@example.com ')).toEqual({
      envelopeMailFrom: 'alias@example.com',
      envelopeFallbackMailFrom: 'me@example.com',
    });
  });

  it('leaves the envelope to the identity that owns the override', () => {
    expect(overrideEnvelope(identities, me, 'info@example.com')).toEqual({});
    expect(overrideEnvelope(identities, me, 'me@example.com')).toEqual({});
  });

  it('asks for the override without a fallback from a wildcard identity', () => {
    expect(overrideEnvelope(identities, wildcard, 'alias@example.com')).toEqual({ envelopeMailFrom: 'alias@example.com' });
  });
});
