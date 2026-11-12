import { describe, it, expect, vi, beforeEach } from 'vitest';

// Masked addresses (webmail lib/stalwart/masked-email.ts): listed, created,
// described, turned off and deleted through x:MaskedEmail, hidden where the
// server has none (Stalwart Community refuses it as Enterprise-only).

type Call = [string, Record<string, unknown>, string];
const { fake } = vi.hoisted(() => ({
  fake: {
    accountId: 'acc',
    serverUrl: 'https://mail.example.org',
    username: 'u@example.org',
    isConnected: true,
    currentSession: {} as object | null,
    caps: ['urn:stalwart:jmap'] as string[],
    sent: [] as Call[],
    usings: [] as unknown[],
    answer: (_call: Call): unknown[] => ['error', { type: 'serverFail' }, 'masked'],
    hasAccountCapability(cap: string) { return this.caps.includes(cap); },
    getMaxObjectsInGet() { return 500; },
    async request(calls: Call[], using?: unknown) {
      this.sent.push(...calls);
      this.usings.push(using);
      return { methodResponses: calls.map((c) => this.answer(c)) };
    },
  },
}));

vi.mock('../jmap-client', () => ({ jmapClient: fake }));

import { createMaskedEmailManager, loadMaskedAddresses, MaskedEmailError } from '../masked-email';

const ok = (name: string, body: Record<string, unknown>) => [name, { accountId: 'acc', ...body }, 'masked'];

// A server with these addresses (`enable` as on Stalwart).
function server(records: Array<Record<string, unknown>>, prop = 'enable') {
  fake.answer = ([name, args]) => {
    if (name === 'x:MaskedEmail/query') {
      const position = (args.position as number) ?? 0;
      return ok(name, { ids: records.slice(position, position + 50).map((r) => r.id), total: records.length });
    }
    if (name === 'x:MaskedEmail/get') {
      const ids = args.ids as string[];
      return ok(name, { list: records.filter((r) => ids.includes(r.id as string)).map((r) => ({ ...r, [prop]: r.on })) });
    }
    if (name === 'x:MaskedEmail/set') {
      if (args.create) return ok(name, { created: { new: { id: 'm-new' } } });
      if (args.update) return ok(name, { updated: Object.fromEntries(Object.keys(args.update as object).map((k) => [k, null])) });
      if (args.destroy) return ok(name, { destroyed: args.destroy });
    }
    return ['error', { type: 'unknownMethod' }, 'masked'];
  };
}

beforeEach(() => {
  fake.sent = [];
  fake.usings = [];
  fake.caps = ['urn:stalwart:jmap'];
  fake.accountId = 'acc';
});

describe('masked addresses', () => {
  it('are not available on Stalwart Community, which refuses them as Enterprise-only', async () => {
    fake.answer = () => ['error', { type: 'forbidden', description: 'This feature is only available in the Enterprise edition. Obtain your trial license at https://license.stalw.art/trial.' }, 'masked'];
    expect(await loadMaskedAddresses()).toEqual({ status: 'unavailable' });
  });

  it('say the session may not list them on any other forbidden, and are unavailable without the extension', async () => {
    fake.answer = () => ['error', { type: 'forbidden', description: 'You are not authorized' }, 'masked'];
    expect(await loadMaskedAddresses()).toEqual({ status: 'forbidden' });
    fake.caps = [];
    expect(await loadMaskedAddresses()).toEqual({ status: 'unavailable' });
    fake.caps = ['urn:stalwart:jmap'];
    fake.answer = () => ['error', { type: 'unknownMethod' }, 'masked'];
    expect(await loadMaskedAddresses()).toEqual({ status: 'unavailable' });
  });

  it('lists the account\'s addresses, filtered by account, reading `enable` on Stalwart', async () => {
    server([
      { id: 'm1', email: 'a1@example.org', description: 'Shop', forDomain: 'shop.example', on: true },
      { id: 'm2', email: 'a2@example.org', description: null, forDomain: null, on: false },
    ]);
    const loaded = await loadMaskedAddresses();
    expect(loaded).toEqual({ status: 'ready', addresses: [
      { id: 'm1', email: 'a1@example.org', description: 'Shop', forDomain: 'shop.example', enabled: true },
      { id: 'm2', email: 'a2@example.org', description: null, forDomain: null, enabled: false },
    ] });
    const query = fake.sent.find((c) => c[0] === 'x:MaskedEmail/query')!;
    expect(query[1]).toMatchObject({ accountId: 'acc', filter: { accountId: 'acc' } });
    expect(fake.sent.find((c) => c[0] === 'x:MaskedEmail/get')![1].properties).toContain('enable');
  });

  it('speaks Inbuxa\'s registry with `enabled`', async () => {
    fake.caps = ['urn:inbuxa:jmap:registry'];
    server([{ id: 'm1', email: 'a1@example.org', on: true }], 'enabled');
    const loaded = await loadMaskedAddresses();
    expect(loaded.status === 'ready' && loaded.addresses[0].enabled).toBe(true);
    expect(fake.usings[0]).toEqual(['urn:ietf:params:jmap:core', 'urn:inbuxa:jmap:registry']);
  });

  it('creates one with no description as null, turns it off and clears its description', async () => {
    server([{ id: 'm1', email: 'a1@example.org', description: 'x', on: true }]);
    const manager = createMaskedEmailManager()!;
    await manager.list();
    expect(await manager.create({ description: '  ', forDomain: '' })).toBe('m-new');
    expect(fake.sent.at(-1)![1].create).toEqual({ new: { description: null, forDomain: null, enable: true } });
    await manager.update('m1', { enabled: false, description: '' });
    expect(fake.sent.at(-1)![1].update).toEqual({ m1: { enable: false, description: null } });
  });

  it('does not send a delete again whose answer was lost, until the list was read', async () => {
    server([{ id: 'm1', email: 'a1@example.org', on: true }]);
    const manager = createMaskedEmailManager()!;
    await manager.list();
    const answer = fake.answer;
    fake.answer = () => { throw new Error('Network request failed'); };
    await expect(manager.destroy('m1')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    fake.answer = answer;
    const sentBefore = fake.sent.length;
    await expect(manager.destroy('m1')).rejects.toBeInstanceOf(MaskedEmailError);
    expect(fake.sent.length).toBe(sentBefore);
    await manager.list();
    await manager.destroy('m1');
    expect(fake.sent.at(-1)![1].destroy).toEqual(['m1']);
  });

  it('refuses an answer for another account', async () => {
    fake.answer = ([name]) => [name, { accountId: 'other', ids: [] }, 'masked'];
    expect(await loadMaskedAddresses()).toEqual({ status: 'error' });
  });
});
