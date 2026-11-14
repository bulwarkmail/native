import { describe, expect, it } from 'vitest';
import {
  MaskedEmailError,
  createMaskedEmailManager,
  maskedEmailErrorType,
  maskedEmailUnavailable,
} from '../masked-email';

// The webmail's lib/__tests__/masked-email.test.ts and
// masked-email-destroy.test.ts, against a scripted server.

type Args = Record<string, any>;
type Answer = Record<string, unknown> | Error;
type Script = (method: string, args: Args) => Answer | Promise<Answer>;

const ACCOUNT = 'personal';
const PROPERTIES = ['id', 'accountId', 'email', 'forDomain', 'description', 'enable'];
const ENTERPRISE = 'This feature is only available in the Enterprise edition. Obtain your trial license at https://license.stalw.art/trial.';

const wire = (id = 'mask') => ({ id, email: `${id}@example.test`, forDomain: 'shop.example.test', description: null, enable: true });
const refusal = (type: string, description?: string) => new MaskedEmailError(type, description);

function setup(script: Script, options: { maxObjectsInGet?: number } = {}) {
  const calls: [string, Args][] = [];
  const state = { current: true };
  const manager = createMaskedEmailManager({
    accountId: ACCOUNT,
    maxObjectsInGet: options.maxObjectsInGet ?? 2,
    isCurrent: () => state.current,
    call: async (method, args) => {
      calls.push([method, args]);
      const answer = await script(method, args);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  return { manager, calls, state, methods: () => calls.map(([method]) => method) };
}

/** A server holding `ids`, answering query in pages of `pageSize` and every get in full. */
function serverWith(ids: string[], options: { pageSize?: number; total?: boolean; set?: Script } = {}): Script {
  const pageSize = options.pageSize ?? 50;
  return (method, args) => {
    if (method === 'x:MaskedEmail/query') {
      return {
        accountId: ACCOUNT,
        ids: ids.slice(args.position, args.position + Math.min(pageSize, args.limit)),
        ...(options.total === false ? {} : { total: ids.length }),
      };
    }
    if (method === 'x:MaskedEmail/get') return { accountId: ACCOUNT, list: (args.ids as string[]).map((id) => wire(id)) };
    return options.set ? options.set(method, args) : new Error(`unexpected ${method}`);
  };
}

describe('listing', () => {
  it('asks for the account alone and returns its addresses', async () => {
    const { manager, calls } = setup(serverWith(['mask']));
    expect(await manager.list()).toEqual([
      { id: 'mask', email: 'mask@example.test', forDomain: 'shop.example.test', description: null, enabled: true },
    ]);
    expect(calls).toEqual([
      ['x:MaskedEmail/query', { accountId: ACCOUNT, filter: { accountId: ACCOUNT }, position: 0, limit: 50, calculateTotal: true }],
      ['x:MaskedEmail/get', { accountId: ACCOUNT, ids: ['mask'], properties: PROPERTIES }],
    ]);
  });

  it('reads every page the server cuts short and stops at its total', async () => {
    const { manager, calls } = setup(serverWith(['a', 'b', 'c', 'd', 'e'], { pageSize: 2 }));
    expect((await manager.list()).map((address) => address.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(calls.filter(([method]) => method === 'x:MaskedEmail/query').map(([, args]) => args.position)).toEqual([0, 2, 4]);
  });

  it('keeps to maxObjectsInGet', async () => {
    const { manager, calls } = setup(serverWith(['a', 'b', 'c']), { maxObjectsInGet: 2 });
    await manager.list();
    expect(calls.filter(([method]) => method === 'x:MaskedEmail/get').map(([, args]) => args.ids)).toEqual([['a', 'b'], ['c']]);
  });

  it('pages until an empty page when the server gives no total', async () => {
    const { manager, calls } = setup(serverWith(['a', 'b', 'c'], { pageSize: 2, total: false }));
    expect((await manager.list()).map((address) => address.id)).toEqual(['a', 'b', 'c']);
    expect(calls.filter(([method]) => method === 'x:MaskedEmail/query').map(([, args]) => args.position)).toEqual([0, 2, 3]);
  });

  it('accepts an empty list only once an empty get succeeded too', async () => {
    const { manager, calls } = setup(serverWith([]));
    expect(await manager.list()).toEqual([]);
    expect(calls[1]).toEqual(['x:MaskedEmail/get', { accountId: ACCOUNT, ids: [], properties: PROPERTIES }]);
  });

  it.each(['forbidden', 'unknownMethod'])('fails an empty query whose get answers %s', async (type) => {
    const { manager, methods } = setup((method) => (method === 'x:MaskedEmail/query' ? { ids: [], total: 0 } : refusal(type)));
    expect(maskedEmailErrorType(await manager.list().catch((e) => e))).toBe(type);
    expect(methods()).toEqual(['x:MaskedEmail/query', 'x:MaskedEmail/get']);
  });

  it.each([
    ['a repeated id', { ids: ['a', 'a'], total: 2 }],
    ['an id that is no string', { ids: [7], total: 1 }],
    ['a total below what was returned', { ids: ['a'], total: 0 }],
    ['a total that is no number', { ids: ['a'], total: '1' }],
    ['no ids', {}],
  ])('rejects a query with %s', async (_name, page) => {
    const { manager } = setup((method, args) => (method === 'x:MaskedEmail/query' ? page : { accountId: ACCOUNT, list: args.ids.map(wire) }));
    await expect(manager.list()).rejects.toMatchObject({ type: 'invalidResponse' });
  });

  it('rejects a list that changed between pages', async () => {
    const totals = [3, 4];
    const { manager } = setup((method, args) => (method === 'x:MaskedEmail/query'
      ? { ids: args.position === 0 ? ['a', 'b'] : ['c'], total: totals.shift() }
      : { accountId: ACCOUNT, list: args.ids.map(wire) }));
    await expect(manager.list()).rejects.toMatchObject({ type: 'listChanged' });
  });

  it('rejects a query state that changed between pages', async () => {
    const { manager } = setup((method, args) => (method === 'x:MaskedEmail/query'
      ? { ids: args.position === 0 ? ['a', 'b'] : ['c'], total: 3, queryState: args.position === 0 ? 's1' : 's2' }
      : { accountId: ACCOUNT, list: args.ids.map(wire) }));
    await expect(manager.list()).rejects.toMatchObject({ type: 'listChanged' });
  });

  it.each([
    ['records nobody asked for', { accountId: ACCOUNT, list: [wire('a')] }, 'invalidResponse'],
    ['no list', { accountId: ACCOUNT }, 'invalidResponse'],
    ['no owner', { list: [] }, 'ownershipMismatch'],
    ['another account', { accountId: 'foreign', list: [] }, 'ownershipMismatch'],
  ])('fails an empty query whose get answers with %s', async (_name, answer, type) => {
    const { manager } = setup((method) => (method === 'x:MaskedEmail/query' ? { ids: [], total: 0 } : answer));
    await expect(manager.list()).rejects.toMatchObject({ type });
  });

  it('rejects a page that ends before the total', async () => {
    const { manager } = setup((method, args) => (method === 'x:MaskedEmail/query'
      ? { ids: args.position === 0 ? ['a'] : [], total: 2 }
      : { accountId: ACCOUNT, list: args.ids.map(wire) }));
    await expect(manager.list()).rejects.toMatchObject({ type: 'invalidResponse' });
  });

  it('does not take records the get left out for a complete list', async () => {
    const { manager } = setup((method) => (method === 'x:MaskedEmail/query'
      ? { ids: ['a', 'b'], total: 2 }
      : { accountId: ACCOUNT, list: [wire('a')] }));
    await expect(manager.list()).rejects.toMatchObject({ type: 'listChanged' });
  });

  it.each([
    ['an id that was not asked for', [wire('other')]],
    ['the same record twice', [wire('a'), wire('a')]],
    ['a switch that is no boolean', [{ ...wire('a'), enable: 'yes' }]],
    ['the other servers\' field name', [{ id: 'a', email: 'a@example.test', enabled: true }]],
    ['no address', [{ id: 'a', enable: true }]],
    ['a description that is no string', [{ ...wire('a'), description: 5 }]],
    ['null for a record', [null]],
  ])('rejects a get with %s', async (_name, list) => {
    const { manager } = setup((method) => (method === 'x:MaskedEmail/query' ? { ids: ['a'], total: 1 } : { accountId: ACCOUNT, list }));
    await expect(manager.list()).rejects.toMatchObject({ type: 'invalidResponse' });
  });

  it.each([
    ['a get without an owner', { list: [{ ...wire('a'), accountId: ACCOUNT }] }],
    ['a get for another account', { accountId: 'foreign', list: [wire('a')] }],
    ['a record of another account', { accountId: ACCOUNT, list: [{ ...wire('a'), accountId: 'foreign' }] }],
  ])('rejects %s', async (_name, answer) => {
    const { manager } = setup((method) => (method === 'x:MaskedEmail/query' ? { ids: ['a'], total: 1 } : answer));
    await expect(manager.list()).rejects.toMatchObject({ type: 'ownershipMismatch' });
  });

  it('rejects a query answered for another account', async () => {
    const { manager, methods } = setup(() => ({ accountId: 'foreign', ids: ['a'], total: 1 }));
    await expect(manager.list()).rejects.toMatchObject({ type: 'ownershipMismatch' });
    expect(methods()).toEqual(['x:MaskedEmail/query']);
  });
});

describe('a server without masked addresses', () => {
  it.each(['unknownMethod', 'unknownCapability', 'notImplemented'])('takes %s for not offered', async (type) => {
    const { manager, calls } = setup(() => refusal(type));
    const error = await manager.list().catch((e) => e);
    expect(maskedEmailUnavailable(error)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it.each(['query', 'get'])('takes the Enterprise-only refusal of %s for not offered, not for a permission', async (step) => {
    const { manager } = setup((method) => (step === 'get' && method === 'x:MaskedEmail/query' ? { ids: [] } : refusal('forbidden', ENTERPRISE)));
    const error = await manager.list().catch((e) => e);
    expect(maskedEmailErrorType(error)).toBe('forbidden');
    expect(maskedEmailUnavailable(error)).toBe(true);
  });

  it('keeps any other forbidden a permission', async () => {
    const { manager } = setup(() => refusal('forbidden', 'Missing permission sysMaskedEmailGet'));
    const error = await manager.list().catch((e) => e);
    expect(maskedEmailErrorType(error)).toBe('forbidden');
    expect(maskedEmailUnavailable(error)).toBe(false);
  });

  it('does not take a failed request for not offered', async () => {
    const { manager } = setup(() => new Error('Network request failed'));
    expect(maskedEmailUnavailable(await manager.list().catch((e) => e))).toBe(false);
  });
});

describe('creating and changing', () => {
  it('creates an enabled address and returns its id', async () => {
    const { manager, calls } = setup(() => ({ accountId: ACCOUNT, created: { new: { id: 'created', email: 'created@example.test' } } }));
    expect(await manager.create({ description: 'Shop', forDomain: 'shop.example.test' })).toBe('created');
    expect(calls).toEqual([['x:MaskedEmail/set', {
      accountId: ACCOUNT, create: { new: { description: 'Shop', forDomain: 'shop.example.test', enable: true } },
    }]]);
  });

  it('sends an empty description or website as null', async () => {
    const { manager, calls } = setup(serverWith(['mask'], {
      set: (_method, args) => (args.create ? { created: { new: { id: 'created' } } } : { updated: { mask: null } }),
    }));
    await manager.create({ description: '', forDomain: '' });
    expect(calls[0][1].create.new).toEqual({ description: null, forDomain: null, enable: true });
    await manager.list();
    await manager.update('mask', { description: '' });
    expect(calls[calls.length - 1][1].update).toEqual({ mask: { description: null } });
  });

  it.each(['forbidden', 'overQuota', 'rateLimit'])('passes on a create the server refused (%s), once', async (type) => {
    const { manager, calls } = setup(() => ({ notCreated: { new: { type } } }));
    await expect(manager.create({ description: '', forDomain: '' })).rejects.toMatchObject({ type });
    expect(calls).toHaveLength(1);
  });

  it('rejects a create answered without an id', async () => {
    const { manager } = setup(() => ({ created: { new: {} } }));
    await expect(manager.create({ description: '', forDomain: '' })).rejects.toMatchObject({ type: 'invalidResponse' });
  });

  it('changes only the description and the switch, under the server\'s field name', async () => {
    const { manager, calls } = setup(serverWith(['mask'], { set: () => ({ updated: { mask: null } }) }));
    await manager.list();
    await manager.update('mask', { enabled: false });
    await manager.update('mask', { description: 'Shop' });
    expect(calls.slice(2).map(([, args]) => args.update)).toEqual([{ mask: { enable: false } }, { mask: { description: 'Shop' } }]);
  });

  it('refuses an id it has not listed, and an empty change, without a request', async () => {
    const { manager, calls } = setup(serverWith(['mask']));
    await expect(manager.update('mask', { enabled: false })).rejects.toMatchObject({ type: 'ownershipMismatch' });
    expect(calls).toHaveLength(0);
    await manager.list();
    await expect(manager.update('mask', {})).rejects.toMatchObject({ type: 'invalidProperties' });
    await expect(manager.update('foreign', { enabled: false })).rejects.toMatchObject({ type: 'ownershipMismatch' });
    expect(calls).toHaveLength(2);
  });

  it('passes on an update the server refused, and rejects one it did not confirm', async () => {
    const answers: Answer[] = [{ notUpdated: { mask: { type: 'forbidden' } } }, { updated: {} }];
    const { manager } = setup(serverWith(['mask'], { set: () => answers.shift()! }));
    await manager.list();
    await expect(manager.update('mask', { enabled: false })).rejects.toMatchObject({ type: 'forbidden' });
    await expect(manager.update('mask', { enabled: false })).rejects.toMatchObject({ type: 'invalidResponse' });
  });
});

describe('deleting', () => {
  const deleted = { accountId: ACCOUNT, destroyed: ['mask'] };

  it('sends the one listed id and forgets it once the server confirmed', async () => {
    const { manager, calls } = setup(serverWith(['mask'], { set: () => deleted }));
    await manager.list();
    await manager.destroy('mask');
    expect(calls[2]).toEqual(['x:MaskedEmail/set', { accountId: ACCOUNT, destroy: ['mask'] }]);
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'ownershipMismatch' });
    await expect(manager.update('mask', { enabled: true })).rejects.toMatchObject({ type: 'ownershipMismatch' });
    expect(calls).toHaveLength(3);
  });

  it('refuses an id it has not listed without a request', async () => {
    const { manager, calls } = setup(serverWith(['mask']));
    await expect(manager.destroy('foreign')).rejects.toMatchObject({ type: 'ownershipMismatch' });
    expect(calls).toHaveLength(0);
  });

  it.each(['forbidden', 'notFound'])('passes on a delete the server refused (%s) and lets it be asked again', async (type) => {
    const answers: Answer[] = [{ accountId: ACCOUNT, notDestroyed: { mask: { type } } }, deleted];
    const { manager } = setup(serverWith(['mask'], { set: () => answers.shift()! }));
    await manager.list();
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type });
    await manager.destroy('mask');
  });

  it.each([
    {}, { accountId: 'foreign', destroyed: ['mask'] }, { destroyed: ['mask'] },
    { accountId: ACCOUNT, destroyed: ['other'] }, { accountId: ACCOUNT, destroyed: ['mask', 'mask'] },
    { accountId: ACCOUNT, destroyed: ['mask'], notDestroyed: { mask: { type: 'forbidden' } } },
    { accountId: ACCOUNT, notDestroyed: { mask: null } },
  ])('does not repeat a delete answered with %j', async (answer) => {
    const { manager, calls } = setup(serverWith(['mask'], { set: () => answer }));
    await manager.list();
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    expect(calls).toHaveLength(3);
  });

  it('does not repeat a delete that got no answer until a fresh list shows the address', async () => {
    const answers: Answer[] = [new Error('Network request failed'), deleted];
    const { manager, calls } = setup(serverWith(['mask'], { set: () => answers.shift()! }));
    await manager.list();
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    expect(calls).toHaveLength(3);
    await manager.list();
    await manager.destroy('mask');
  });

  it.each(['forbidden', 'notAuthenticated', 'unknownMethod'])('lets a delete the server turned down whole (%s) be asked again', async (type) => {
    const answers: Answer[] = [refusal(type), deleted];
    const { manager } = setup(serverWith(['mask'], { set: () => answers.shift()! }));
    await manager.list();
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type });
    await manager.destroy('mask');
  });

  it('sends a second delete of the same address only after the first was answered', async () => {
    let answer: (value: Answer) => void = () => {};
    const { manager, calls } = setup(serverWith(['mask'], { set: () => new Promise<Answer>((resolve) => { answer = resolve; }) }));
    await manager.list();
    const first = manager.destroy('mask');
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    answer(deleted);
    await first;
    expect(calls).toHaveLength(3);
  });
});

describe('another login becoming active', () => {
  it('sends nothing more', async () => {
    const { manager, calls, state } = setup(serverWith(['mask']));
    await manager.list();
    state.current = false;
    await expect(manager.list()).rejects.toMatchObject({ type: 'staleContext' });
    await expect(manager.create({ description: '', forDomain: '' })).rejects.toMatchObject({ type: 'staleContext' });
    await expect(manager.update('mask', { enabled: false })).rejects.toMatchObject({ type: 'staleContext' });
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'staleContext' });
    expect(calls).toHaveLength(2);
  });

  it('leaves a delete answered afterwards unconfirmed', async () => {
    const { manager, calls, state } = setup(serverWith(['mask'], {
      set: () => {
        state.current = false;
        return { accountId: ACCOUNT, destroyed: ['mask'] };
      },
    }));
    await manager.list();
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    state.current = true;
    await expect(manager.destroy('mask')).rejects.toMatchObject({ type: 'deleteUnconfirmed' });
    expect(calls).toHaveLength(3);
  });

  it('drops an answer that arrives afterwards', async () => {
    const { manager, state } = setup((method) => {
      state.current = false;
      return method === 'x:MaskedEmail/query' ? { ids: ['mask'], total: 1 } : new Error('unexpected');
    });
    await expect(manager.list()).rejects.toMatchObject({ type: 'staleContext' });
  });
});
