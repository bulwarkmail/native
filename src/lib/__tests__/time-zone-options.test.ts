import { describe, it, expect } from 'vitest';
import { availableTimeZones, timeZoneOptions, COMMON_TIME_ZONES } from '../time-zone-options';

describe('availableTimeZones', () => {
  it('offers every zone the runtime knows, and the hand-picked list without it', () => {
    expect(availableTimeZones({ supportedValuesOf: () => ['Asia/Kathmandu', 'UTC'] })).toEqual(['Asia/Kathmandu', 'UTC']);
    expect(availableTimeZones({})).toBe(COMMON_TIME_ZONES);
    expect(availableTimeZones({ supportedValuesOf: () => { throw new RangeError(); } })).toBe(COMMON_TIME_ZONES);
  });

  it('falls back when the runtime lists nothing', () => {
    expect(availableTimeZones({ supportedValuesOf: () => [] })).toBe(COMMON_TIME_ZONES);
  });
});

describe('timeZoneOptions', () => {
  it('puts automatic first, then the device, listed and current zones sorted', () => {
    const opts = timeZoneOptions('Europe/Berlin', 'America/New_York', 'Auto', ['UTC', 'Asia/Kathmandu']);
    expect(opts.map((o) => o.value)).toEqual(['auto', 'America/New_York', 'Asia/Kathmandu', 'Europe/Berlin', 'UTC']);
    expect(opts[1].label).toBe('America/New York');
  });

  it('always offers UTC, which V8 does not list', () => {
    expect(timeZoneOptions('Europe/Berlin', undefined, 'Auto', ['Europe/Berlin']).map((o) => o.value))
      .toEqual(['auto', 'Europe/Berlin', 'UTC']);
  });
});
