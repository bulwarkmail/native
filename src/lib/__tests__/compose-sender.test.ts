import { describe, expect, it } from 'vitest';
import { activeFromOverride, composeSenderAddress } from '../compose-sender';
import type { Identity } from '../../api/types';

const identity: Identity = { id: 'i1', name: 'Ada Lovelace', email: 'ada@example.org', mayDelete: true };
const override = { name: 'Support', email: 'support@example.org' };

describe('composeSenderAddress', () => {
  it('writes the custom From and keeps the identity as envelope sender', () => {
    expect(composeSenderAddress(identity, { fromOverride: override, customFromEnabled: true, subAddressTag: '' })).toEqual({
      from: { name: 'Support', email: 'support@example.org' },
      envelopeMailFrom: 'ada@example.org',
    });
  });

  it('sends from the identity when the organisation turned custom From off', () => {
    expect(composeSenderAddress(identity, { fromOverride: override, customFromEnabled: false, subAddressTag: '' })).toEqual({
      from: { name: 'Ada Lovelace', email: 'ada@example.org' },
      envelopeMailFrom: undefined,
    });
  });

  it('keeps the sub-address tag when custom From is off', () => {
    const { from, envelopeMailFrom } = composeSenderAddress(identity, {
      fromOverride: override, customFromEnabled: false, subAddressTag: 'shop', subAddressDelimiter: '+',
    });
    expect(from).toEqual({ name: 'Ada Lovelace', email: 'ada+shop@example.org' });
    expect(envelopeMailFrom).toBe('ada@example.org');
  });
});

describe('activeFromOverride', () => {
  it('drops an override when custom From is off', () => {
    expect(activeFromOverride(override, true)).toBe(override);
    expect(activeFromOverride(override, false)).toBeNull();
    expect(activeFromOverride(null, true)).toBeNull();
  });
});
