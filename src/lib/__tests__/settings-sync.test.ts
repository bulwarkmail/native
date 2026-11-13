import { describe, it, expect } from 'vitest';
import {
  hasOwnEntry, isSettingName, nextStamp, planSettingsSync, readRemoteSettings, sameJson, settingsWrites,
  shardKey, shardOf, SHARD_COUNT, syncSectionView, UNKNOWN_AGE, valueKey,
  type LocalSetting, type RemoteSettings, type SettingPush,
} from '../settings-sync';

// Settings in an account's Inbox metadata (#117, docs/settings-sync.md):
// where a setting is filed, how the entries are read, and how one device's
// settings and the account's come together.

const local = (over: Partial<LocalSetting> & { name: string }): LocalSetting => ({
  value: false,
  defaultValue: false,
  at: 0,
  reset: false,
  chosen: false,
  locked: false,
  accept: (value) => value,
  ...over,
});

const remoteOf = (settings: Record<string, { at: number; value?: unknown }>, shards: number[] = []): RemoteSettings => ({
  settings: new Map(Object.entries(settings).map(([name, s]) => [
    name,
    'value' in s ? { at: s.at, hasValue: true, value: s.value } : { at: s.at, hasValue: false },
  ])),
  shards: new Set(shards),
});

describe('where a setting is filed', () => {
  it('gives a name the same shard on every device', () => {
    // FNV-1a (32 bit) of the name, modulo 8. Fixed values, so a change of the
    // hash shows up here: the webmail has to file a setting in the same shard.
    expect(Object.fromEntries(
      ['showPreview', 'density', 'timeFormat', 'firstDayOfWeek', 'emailsPerPage', 'activeThemeId', 'theme', 'a']
        .map((name) => [name, shardOf(name)]),
    )).toEqual({
      showPreview: 0, density: 3, timeFormat: 7, firstDayOfWeek: 0, emailsPerPage: 0, activeThemeId: 5, theme: 2, a: 4,
    });
    expect(shardOf('showPreview')).toBe(shardOf('showPreview'));
    for (const name of ['a', 'showPreview', 'x9']) {
      expect(shardOf(name)).toBeGreaterThanOrEqual(0);
      expect(shardOf(name)).toBeLessThan(SHARD_COUNT);
    }
    expect(shardKey(3)).toBe('settings.shard.3');
  });

  it('spreads the names over the shards', () => {
    const names = Array.from({ length: 400 }, (_, i) => `setting${i}Name`);
    const counts = new Array(SHARD_COUNT).fill(0);
    for (const name of names) counts[shardOf(name)] += 1;
    expect(Math.min(...counts)).toBeGreaterThan(25);
    expect(Math.max(...counts)).toBeLessThan(80);
  });

  it('names the entry of a list or map after the setting, in a form a metadata key takes', () => {
    expect(valueKey('trustedSenders')).toBe('settings.value.trusted-senders');
    expect(valueKey('offlineCacheMaxMB')).toBe('settings.value.offline-cache-max-m-b');
    expect(valueKey('sidebarApps')).toMatch(/^[a-z0-9.-]+$/);
  });

  it('files lists and maps on their own and everything else in a shard', () => {
    expect(hasOwnEntry([])).toBe(true);
    expect(hasOwnEntry({})).toBe(true);
    expect(hasOwnEntry(null)).toBe(false);
    expect(hasOwnEntry('x')).toBe(false);
    expect(hasOwnEntry(false)).toBe(false);
    expect(hasOwnEntry(0)).toBe(false);
  });

  it('takes only plain names', () => {
    expect(isSettingName('showPreview')).toBe(true);
    expect(isSettingName('a1')).toBe(true);
    expect(isSettingName('')).toBe(false);
    expect(isSettingName('1a')).toBe(false);
    expect(isSettingName('a/b')).toBe(false);
    expect(isSettingName('__proto__')).toBe(false);
    expect(isSettingName('a'.repeat(65))).toBe(false);
  });
});

describe('reading the account entries', () => {
  it('reads plain settings from the shards and lists from their own entries', () => {
    const read = readRemoteSettings({
      'settings.shard.2': { showPreview: { v: false, at: 100 }, density: { at: 200 } },
      'settings.value.trusted-senders': { k: 'trustedSenders', v: ['a@example.org'], at: 300 },
      'template.abc': { name: 'A template' },
      templates: { version: 1, deleted: {} },
    });
    expect(Object.fromEntries(read.settings)).toEqual({
      showPreview: { at: 100, hasValue: true, value: false },
      density: { at: 200, hasValue: false },
      trustedSenders: { at: 300, hasValue: true, value: ['a@example.org'] },
    });
    expect([...read.shards]).toEqual([2]);
  });

  it('keeps a null value apart from a setting put back to its default', () => {
    const read = readRemoteSettings({ 'settings.shard.0': { activeThemeId: { v: null, at: 5 }, theme: { at: 6 } } });
    expect(read.settings.get('activeThemeId')).toEqual({ at: 5, hasValue: true, value: null });
    expect(read.settings.get('theme')).toEqual({ at: 6, hasValue: false });
  });

  it('takes a setting found twice from the newer of the two', () => {
    const read = readRemoteSettings({
      'settings.shard.1': { trustedSenders: { v: ['old@example.org'], at: 10 } },
      'settings.value.trusted-senders': { k: 'trustedSenders', v: ['new@example.org'], at: 20 },
    });
    expect(read.settings.get('trustedSenders')).toEqual({ at: 20, hasValue: true, value: ['new@example.org'] });
  });

  it('leaves alone what does not read as a setting', () => {
    const read = readRemoteSettings({
      'settings.shard.9': { showPreview: { v: true, at: 1 } },
      'settings.shard.x': { showPreview: { v: true, at: 1 } },
      'settings.shard.1': 'text',
      'settings.shard.2': {
        noStamp: { v: true },
        zeroStamp: { v: true, at: 0 },
        textStamp: { v: true, at: 'now' },
        notAnObject: true,
        'bad name': { v: true, at: 5 },
        good: { v: true, at: 5 },
      },
      'settings.value.no-name': { v: [1], at: 5 },
      'settings.value.list': [1, 2],
    });
    expect([...read.settings.keys()]).toEqual(['good']);
    expect([...read.shards]).toEqual([2]);
    expect(readRemoteSettings(null).settings.size).toBe(0);
  });
});

describe('sameJson', () => {
  it('compares values whatever order their members come in', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: null })).toBe(false);
    expect(sameJson(null, {})).toBe(false);
    expect(sameJson([], {})).toBe(false);
    expect(sameJson('1', 1)).toBe(false);
  });
});

describe('planning a round', () => {
  it('does nothing for settings neither side has changed', () => {
    const plan = planSettingsSync([local({ name: 'showPreview', value: true, defaultValue: true })], remoteOf({}));
    expect(plan).toEqual({ take: {}, reset: [], stamps: {}, resets: {}, push: [], replaced: {} });
  });

  it('takes a value the account holds and this device has no stamp for', () => {
    const plan = planSettingsSync(
      [local({ name: 'showPreview', value: true, defaultValue: true })],
      remoteOf({ showPreview: { at: 500, value: false } }),
    );
    expect(plan.take).toEqual({ showPreview: false });
    expect(plan.stamps).toEqual({ showPreview: 500 });
    expect(plan.push).toEqual([]);
    expect(plan.replaced).toEqual({});
  });

  it('takes the newer value of the account and sends the newer value of the device', () => {
    const plan = planSettingsSync(
      [
        local({ name: 'density', value: 'compact', defaultValue: 'regular', at: 100, chosen: true }),
        local({ name: 'timeFormat', value: '24h', defaultValue: '12h', at: 300, chosen: true }),
      ],
      remoteOf({ density: { at: 200, value: 'comfortable' }, timeFormat: { at: 250, value: '12h' } }),
    );
    expect(plan.take).toEqual({ density: 'comfortable' });
    expect(plan.stamps).toEqual({ density: 200 });
    expect(plan.push).toEqual([{ name: 'timeFormat', at: 300, reset: false, value: '24h', ownEntry: false }]);
  });

  it('leaves a setting alone when both sides hold the same change', () => {
    const plan = planSettingsSync(
      [local({ name: 'density', value: 'compact', defaultValue: 'regular', at: 200, chosen: true })],
      remoteOf({ density: { at: 200, value: 'compact' } }),
    );
    expect(plan.take).toEqual({});
    expect(plan.push).toEqual([]);
  });

  it('takes the value of the account when two devices wrote at the same stamp', () => {
    // Both filled the same gap on their first round; the account holds the one written last.
    const plan = planSettingsSync(
      [
        local({ name: 'density', value: 'compact', defaultValue: 'regular', at: UNKNOWN_AGE, chosen: true }),
        local({ name: 'timeFormat', value: '24h', defaultValue: '12h', at: 800, chosen: true }),
        local({ name: 'showPreview', value: true, defaultValue: true, at: 800, reset: true }),
      ],
      remoteOf({
        density: { at: UNKNOWN_AGE, value: 'comfortable' },
        timeFormat: { at: 800 },
        showPreview: { at: 800, value: false },
      }),
    );
    expect(plan.take).toEqual({ density: 'comfortable', showPreview: false });
    expect(plan.reset).toEqual(['timeFormat']);
    expect(plan.push).toEqual([]);
    // Only the choice from before stamps existed is offered back.
    expect(plan.replaced).toEqual({ density: 'compact' });
  });

  it('fills a gap in the account with a value chosen before stamps existed, as one of unknown age', () => {
    const plan = planSettingsSync(
      [
        local({ name: 'density', value: 'compact', defaultValue: 'regular', chosen: true }),
        local({ name: 'trustedSenders', value: ['a@example.org'], defaultValue: [], chosen: true }),
        local({ name: 'showPreview', value: true, defaultValue: true }),
      ],
      remoteOf({}),
    );
    expect(plan.push).toEqual([
      { name: 'density', at: UNKNOWN_AGE, reset: false, value: 'compact', ownEntry: false },
      { name: 'trustedSenders', at: UNKNOWN_AGE, reset: false, value: ['a@example.org'], ownEntry: true },
    ]);
    expect(plan.stamps).toEqual({ density: UNKNOWN_AGE, trustedSenders: UNKNOWN_AGE });
  });

  it('gives way to the account for a value chosen before stamps existed, and remembers it', () => {
    const plan = planSettingsSync(
      [local({ name: 'density', value: 'compact', defaultValue: 'regular', chosen: true })],
      remoteOf({ density: { at: UNKNOWN_AGE, value: 'comfortable' } }),
    );
    expect(plan.take).toEqual({ density: 'comfortable' });
    expect(plan.replaced).toEqual({ density: 'compact' });
    expect(plan.push).toEqual([]);
  });

  it('does not count a value as replaced when it is the same or was never chosen', () => {
    const plan = planSettingsSync(
      [
        local({ name: 'density', value: 'compact', defaultValue: 'regular', chosen: true }),
        local({ name: 'timeFormat', value: '12h', defaultValue: '12h' }),
      ],
      remoteOf({ density: { at: 9, value: 'compact' }, timeFormat: { at: 9, value: '24h' } }),
    );
    expect(plan.replaced).toEqual({});
    expect(plan.take).toEqual({ timeFormat: '24h' });
    expect(plan.stamps).toEqual({ density: 9, timeFormat: 9 });
  });

  it('marks a value as chosen here when another device chose the value this one has by default', () => {
    const plan = planSettingsSync(
      [local({ name: 'showPreview', value: true, defaultValue: true })],
      remoteOf({ showPreview: { at: 50, value: true } }),
    );
    expect(plan.take).toEqual({ showPreview: true });
  });

  it('sends a value nobody chose as "the default", not as a choice', () => {
    // An imported file stamps every setting it names, also the ones it leaves at the default.
    const plan = planSettingsSync(
      [
        local({ name: 'showPreview', value: true, defaultValue: true, at: 600 }),
        local({ name: 'sidebarApps', value: [], defaultValue: [], at: 600 }),
      ],
      remoteOf({ showPreview: { at: 100, value: false } }),
    );
    expect(plan.push).toEqual([
      { name: 'showPreview', at: 600, reset: true, ownEntry: false },
      { name: 'sidebarApps', at: 600, reset: true, ownEntry: true },
    ]);
  });

  it('reads only the eight shard names', () => {
    const read = readRemoteSettings({
      'settings.shard.01': { density: { v: 'compact', at: 5 } },
      'settings.shard.1e0': { density: { v: 'compact', at: 5 } },
      'settings.shard.8': { density: { v: 'compact', at: 5 } },
      'settings.shard.7': { timeFormat: { v: '12h', at: 5 } },
    });
    expect([...read.shards]).toEqual([7]);
    expect([...read.settings.keys()]).toEqual(['timeFormat']);
  });

  it('sends again what the account lost', () => {
    // Another device created the shard at the same moment and wrote over this one's member.
    const plan = planSettingsSync(
      [local({ name: 'density', value: 'compact', defaultValue: 'regular', at: 700, chosen: true })],
      remoteOf({}),
    );
    expect(plan.push).toEqual([{ name: 'density', at: 700, reset: false, value: 'compact', ownEntry: false }]);
  });

  it('puts a setting back to its default when another device did, and sends a reset made here', () => {
    const plan = planSettingsSync(
      [
        local({ name: 'density', value: 'compact', defaultValue: 'regular', at: 100, chosen: true }),
        local({ name: 'timeFormat', value: '12h', defaultValue: '12h', at: 400, reset: true }),
        local({ name: 'showPreview', value: true, defaultValue: true, at: 100, chosen: true }),
      ],
      remoteOf({ density: { at: 300 }, timeFormat: { at: 350, value: '24h' }, showPreview: { at: 300 } }),
    );
    expect(plan.reset).toEqual(['density', 'showPreview']);
    expect(plan.resets).toEqual({ density: true, showPreview: true });
    expect(plan.push).toEqual([{ name: 'timeFormat', at: 400, reset: true, ownEntry: false }]);
  });

  it('notes a reset of the account without touching a setting already at its default', () => {
    const plan = planSettingsSync(
      [local({ name: 'density', value: 'regular', defaultValue: 'regular' })],
      remoteOf({ density: { at: 300 } }),
    );
    expect(plan.reset).toEqual([]);
    expect(plan.stamps).toEqual({ density: 300 });
    expect(plan.resets).toEqual({ density: true });
  });

  it('neither takes nor sends a setting the organisation pins', () => {
    const plan = planSettingsSync(
      [
        local({ name: 'density', value: 'compact', defaultValue: 'regular', at: 900, chosen: true, locked: true }),
        local({ name: 'timeFormat', value: '24h', defaultValue: '12h', locked: true }),
      ],
      remoteOf({ timeFormat: { at: 500, value: '12h' } }),
    );
    expect(plan).toEqual({ take: {}, reset: [], stamps: {}, resets: {}, push: [], replaced: {} });
  });

  it('leaves a value this device cannot use where it is, and never writes over it', () => {
    const refuse = () => undefined;
    const plan = planSettingsSync(
      [
        local({ name: 'density', value: 'regular', defaultValue: 'regular', accept: refuse }),
        local({ name: 'timeFormat', value: '24h', defaultValue: '12h', at: 100, chosen: true, accept: refuse }),
      ],
      remoteOf({ density: { at: 500, value: 'spacious' }, timeFormat: { at: 500, value: 'swatch' } }),
    );
    expect(plan).toEqual({ take: {}, reset: [], stamps: {}, resets: {}, push: [], replaced: {} });
  });

  it('uses the value as the device would store it', () => {
    const plan = planSettingsSync(
      [local({ name: 'debugCategories', value: { jmap: true }, defaultValue: { jmap: true }, accept: (v) => ({ jmap: true, ...(v as object) }) })],
      remoteOf({ debugCategories: { at: 5, value: { push: false } } }),
    );
    expect(plan.take).toEqual({ debugCategories: { jmap: true, push: false } });
  });
});

describe('nextStamp', () => {
  it('is now, or just after the stamp it replaces when that came from a fast clock', () => {
    expect(nextStamp(undefined, 1000)).toBe(1000);
    expect(nextStamp(400, 1000)).toBe(1000);
    expect(nextStamp(5000, 1000)).toBe(5001);
  });
});

describe('the writes of a round', () => {
  const push = (name: string, over: Partial<SettingPush> = {}): SettingPush => ({
    name, at: 10, reset: false, value: true, ownEntry: false, ...over,
  });

  it('writes one member of a shard that exists', () => {
    const shard = shardOf('showPreview');
    const writes = settingsWrites([push('showPreview', { value: false })], new Set([shard]));
    expect(writes.shards).toEqual([{ key: shardKey(shard), member: 'showPreview', value: { v: false, at: 10 } }]);
    expect(writes.values).toEqual([]);
  });

  it('creates a missing shard whole, with every setting sent to it', () => {
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu'];
    const writes = settingsWrites(names.map((name) => push(name)), new Set());
    const entries = writes.shards.filter((change) => change.member === undefined);
    expect(writes.shards.every((change) => change.member === undefined)).toBe(true);
    const filed = entries.flatMap((change) => Object.keys(change.value as object));
    expect(filed.sort()).toEqual([...names].sort());
    for (const change of entries) {
      for (const name of Object.keys(change.value as object)) expect(change.key).toBe(shardKey(shardOf(name)));
    }
  });

  it('writes a reset as a stamp without a value', () => {
    const shard = shardOf('density');
    expect(settingsWrites([{ name: 'density', at: 77, reset: true, ownEntry: false }], new Set([shard])).shards)
      .toEqual([{ key: shardKey(shard), member: 'density', value: { at: 77 } }]);
    expect(settingsWrites([{ name: 'trustedSenders', at: 77, reset: true, ownEntry: true }], new Set()).values)
      .toEqual([{ name: 'trustedSenders', at: 77, change: { key: 'settings.value.trusted-senders', value: { k: 'trustedSenders', at: 77 } } }]);
  });

  it('gives each list an update of its own', () => {
    const writes = settingsWrites(
      [push('trustedSenders', { value: ['a@example.org'], ownEntry: true }), push('sidebarApps', { value: [], ownEntry: true })],
      new Set(),
    );
    expect(writes.shards).toEqual([]);
    expect(writes.values.map((write) => write.change.key)).toEqual(['settings.value.trusted-senders', 'settings.value.sidebar-apps']);
    expect(writes.values[0].change.value).toEqual({ k: 'trustedSenders', v: ['a@example.org'], at: 10 });
  });

  it('keeps a null value', () => {
    const shard = shardOf('activeThemeId');
    expect(settingsWrites([push('activeThemeId', { value: null })], new Set([shard])).shards[0].value).toEqual({ v: null, at: 10 });
  });
});

// Several devices and one account, each device following the plan and
// nothing else: whatever they change and in whatever order they sync, they
// end up with the same settings, and those are the latest change of each.
describe('devices converge', () => {
  const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'listOne', 'listTwo'];
  const DEFAULTS: Record<string, unknown> = { alpha: false, beta: 'x', gamma: 0, delta: null, listOne: [], listTwo: {} };

  interface Device {
    values: Record<string, unknown>;
    chosen: Set<string>;
    stamps: Record<string, number>;
    resets: Set<string>;
  }

  function mulberry32(seed: number) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const newDevice = (): Device => ({ values: { ...DEFAULTS }, chosen: new Set(), stamps: {}, resets: new Set() });

  function syncDevice(device: Device, account: Record<string, Record<string, unknown>>) {
    const remote = readRemoteSettings(account);
    const plan = planSettingsSync(NAMES.map((name) => ({
      name,
      value: device.values[name],
      defaultValue: DEFAULTS[name],
      at: device.stamps[name] ?? 0,
      reset: device.resets.has(name),
      chosen: device.chosen.has(name),
      locked: false,
      accept: (value: unknown) => value,
    })), remote);
    for (const [name, value] of Object.entries(plan.take)) {
      device.values[name] = value;
      device.chosen.add(name);
    }
    for (const name of plan.reset) {
      device.values[name] = DEFAULTS[name];
      device.chosen.delete(name);
    }
    for (const [name, at] of Object.entries(plan.stamps)) {
      device.stamps[name] = at;
      if (plan.resets[name]) device.resets.add(name);
      else device.resets.delete(name);
    }
    // The writes happen later: other devices may read and write in between.
    const writes = settingsWrites(plan.push, remote.shards);
    return () => {
      // One update for the shards, applied whole or not at all, as the server does.
      if (writes.shards.every((change) => change.member === undefined || account[change.key])) {
        for (const change of writes.shards) {
          if (change.member === undefined) account[change.key] = structuredClone(change.value) as Record<string, unknown>;
          else account[change.key][change.member] = structuredClone(change.value);
        }
      }
      for (const { change } of writes.values) account[change.key] = structuredClone(change.value) as Record<string, unknown>;
    };
  }

  it.each(Array.from({ length: 40 }, (_, i) => i + 1))('after any run of changes and rounds (seed %i)', (seed) => {
    const random = mulberry32(seed);
    const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
    const account: Record<string, Record<string, unknown>> = {};
    const devices = [newDevice(), newDevice(), newDevice()];
    // The second device chose things before it ever synced.
    devices[1].values.alpha = true; devices[1].chosen.add('alpha');
    devices[1].values.listOne = ['early']; devices[1].chosen.add('listOne');
    let clock = 1000;
    const pending: Array<() => void> = [];
    const latest: Record<string, { at: number; value: unknown; reset: boolean }> = {};
    for (let step = 0; step < 300; step++) {
      const device = pick(devices);
      const roll = random();
      if (roll < 0.45) {
        // A round's writes land at once, or only after some other steps.
        const write = syncDevice(device, account);
        if (random() < 0.5) write();
        else pending.push(write);
        continue;
      }
      if (pending.length > 0 && random() < 0.5) pending.splice(Math.floor(random() * pending.length), 1)[0]();
      const name = pick(NAMES);
      // Each device's clock is off by its own amount, and a change is always later than the one it replaces.
      clock += 1 + Math.floor(random() * 5);
      const at = nextStamp(device.stamps[name], clock + devices.indexOf(device) * 3);
      device.stamps[name] = at;
      if (roll < 0.55) {
        device.values[name] = DEFAULTS[name];
        device.chosen.delete(name);
        device.resets.add(name);
      } else {
        device.values[name] = Array.isArray(DEFAULTS[name]) ? [`v${step}`] : typeof DEFAULTS[name] === 'object' && DEFAULTS[name] !== null ? { k: step } : `v${step}`;
        device.chosen.add(name);
        device.resets.delete(name);
      }
      if (!latest[name] || at > latest[name].at) latest[name] = { at, value: device.values[name], reset: device.resets.has(name) };
      else if (at === latest[name].at) delete latest[name]; // a tie: either may win, as long as all agree
    }
    for (const write of pending) write();
    for (let pass = 0; pass < 3; pass++) for (const device of devices) syncDevice(device, account)();

    for (const name of NAMES) {
      expect(devices[1].values[name], name).toEqual(devices[0].values[name]);
      expect(devices[2].values[name], name).toEqual(devices[0].values[name]);
      expect(devices[1].chosen.has(name), name).toBe(devices[0].chosen.has(name));
      expect(devices[2].chosen.has(name), name).toBe(devices[0].chosen.has(name));
      if (latest[name]) expect(devices[0].values[name], name).toEqual(latest[name].value);
    }
    // A quiet round changes nothing and sends nothing.
    const before = JSON.stringify(account);
    for (const device of devices) syncDevice(device, account)();
    expect(JSON.stringify(account)).toBe(before);
  });
});

describe('the Settings sync section', () => {
  const view = (over: Partial<Parameters<typeof syncSectionView>[0]> = {}) =>
    syncSectionView({ enabled: true, status: 'synced', accountIds: ['a'], picked: 'a', ...over });

  it('shows the switch and the status for one account, without a picker', () => {
    expect(view()).toEqual({ visible: true, holder: 'a', showPicker: false, canSyncNow: true });
  });

  it('names the first account as the holder until one has been taken', () => {
    expect(view({ accountIds: ['a', 'b'], picked: null })).toMatchObject({ holder: 'a', showPicker: true });
  });

  it('is not there without an account, or on a server that keeps no settings with no other account to pick', () => {
    expect(view({ accountIds: [], picked: null }).visible).toBe(false);
    expect(view({ status: 'unsupported' }).visible).toBe(false);
    expect(view({ status: 'unsupported', accountIds: ['a', 'b'] })).toMatchObject({ visible: true, showPicker: true, canSyncNow: false });
  });

  it('asks for an account, also with a single one, when the holder is signed out', () => {
    expect(view({ status: 'signed-out', accountIds: ['b'], picked: 'a' }))
      .toEqual({ visible: true, holder: '', showPicker: true, canSyncNow: false });
  });

  it('shows only the switch while sync is off', () => {
    expect(view({ enabled: false, accountIds: ['a', 'b'] })).toMatchObject({ visible: true, showPicker: false, canSyncNow: false });
  });
});
