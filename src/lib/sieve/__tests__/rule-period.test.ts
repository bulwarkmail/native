import { describe, it, expect } from 'vitest';
import { periodError, periodFromInput, periodToInput } from '../rule-period';
import { utcIsoToLocalInput } from '../../vacation-dates';

describe('rule period fields', () => {
  it('shows a stored boundary in local time and an unreadable one as empty', () => {
    expect(periodToInput('2026-11-02T07:00:00.000Z')).toBe(utcIsoToLocalInput('2026-11-02T07:00:00.000Z'));
    expect(periodToInput('next monday')).toBe('');
    expect(periodToInput(undefined)).toBe('');
  });

  it('stores the typed local time as a UTC moment', () => {
    const local = new Date(2026, 10, 2, 9, 30);
    expect(periodFromInput('2026-11-02 09:30', undefined)).toBe(local.toISOString());
  });

  it('keeps a stored boundary exactly while its field is left as shown', () => {
    const saved = '2026-11-02T07:00:42.000Z';
    expect(periodFromInput(periodToInput(saved), saved)).toBe(saved);
  });

  it('reads an empty field as an open end and garbage as unusable', () => {
    expect(periodFromInput('  ', undefined)).toBeUndefined();
    expect(periodFromInput('2026-13-45', undefined)).toBeNull();
  });

  it('says what is wrong with a period', () => {
    expect(periodError(undefined, undefined)).toBe('empty');
    expect(periodError(null, undefined)).toBe('invalid');
    expect(periodError('2026-11-02T10:00:00.000Z', '2026-11-02T09:00:00.000Z')).toBe('order');
    expect(periodError('2026-11-02T10:00:00.000Z', undefined)).toBeNull();
  });
});
