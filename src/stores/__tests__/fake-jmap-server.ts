// A small in-memory JMAP server for store tests that assert the wire: it
// answers Email/query (text / inMailbox / hasKeyword / notKeyword filters,
// newest first, position + limit), Email/get and Thread/get (including
// result references), and applies Email/set updates and destroys. Every
// request is recorded so a test can check which method calls went out, and
// in how many requests.

import type { Email, JMAPMethodCall } from '../../api/types';

export type FakeEmail = Pick<Email, 'id' | 'threadId' | 'mailboxIds' | 'keywords' | 'receivedAt' | 'subject'>
  & Partial<Email>;

type Filter = Record<string, unknown>;

function matches(email: FakeEmail, filter: Filter | undefined): boolean {
  if (!filter) return true;
  if ('operator' in filter) {
    const results = (filter.conditions as Filter[]).map((c) => matches(email, c));
    if (filter.operator === 'AND') return results.every(Boolean);
    if (filter.operator === 'OR') return results.some(Boolean);
    return !results.some(Boolean);
  }
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'text') {
      const needle = String(value).replace(/\*/g, '').toLowerCase();
      if (!`${email.subject ?? ''} ${email.preview ?? ''}`.toLowerCase().includes(needle)) return false;
    } else if (key === 'inMailbox') {
      if (!email.mailboxIds[value as string]) return false;
    } else if (key === 'hasKeyword') {
      if (!email.keywords[value as string]) return false;
    } else if (key === 'notKeyword') {
      if (email.keywords[value as string]) return false;
    } else {
      throw new Error(`fake server: unsupported filter ${key}`);
    }
  }
  return true;
}

function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function createFakeJmap(accounts: Record<string, FakeEmail[]>) {
  const requests: JMAPMethodCall[][] = [];
  /** JMAP account id → error type every call for it is answered with. */
  const failing = new Map<string, string>();

  const request = async (calls: JMAPMethodCall[]) => {
    requests.push(calls);
    const responses: Array<[string, Record<string, any>, string]> = [];
    const byCallId = new Map<string, [string, Record<string, any>, string]>();
    for (const [name, args, callId] of calls) {
      const accountId = args.accountId as string;
      let response: [string, Record<string, any>, string];
      const store = accounts[accountId];
      if (failing.has(accountId)) {
        response = ['error', { type: failing.get(accountId) }, callId];
      } else if (!store) {
        response = ['error', { type: 'accountNotFound' }, callId];
      } else {
        const ref = args['#ids'] as { resultOf: string; path: string } | undefined;
        let ids = args.ids as string[] | undefined;
        if (ref) {
          const source = byCallId.get(ref.resultOf);
          if (!source || source[0] === 'error') ids = undefined;
          else if (ref.path === '/ids') ids = source[1].ids;
          else if (ref.path === '/list/*/threadId') ids = (source[1].list as Email[]).map((e) => e.threadId);
          else throw new Error(`fake server: unsupported path ${ref.path}`);
        }
        if (ref && !ids) {
          response = ['error', { type: 'invalidResultReference' }, callId];
        } else if (name === 'Email/query') {
          const all = store
            .filter((e) => matches(e, args.filter as Filter))
            .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
          const position = (args.position as number) ?? 0;
          const limit = (args.limit as number) ?? 50;
          response = ['Email/query', {
            accountId,
            ids: all.slice(position, position + limit).map((e) => e.id),
            total: all.length,
            position,
            queryState: `q-${accountId}`,
          }, callId];
        } else if (name === 'Email/get') {
          const list = (ids ?? store.map((e) => e.id))
            .map((id) => store.find((e) => e.id === id))
            .filter((e): e is FakeEmail => !!e)
            .map((e) => ({ ...e, keywords: { ...e.keywords }, mailboxIds: { ...e.mailboxIds } }));
          response = ['Email/get', { accountId, list, state: `s-${accountId}`, notFound: [] }, callId];
        } else if (name === 'Thread/get') {
          const list = [...new Set(ids ?? [])].map((id) => ({
            id,
            emailIds: store.filter((e) => e.threadId === id).map((e) => e.id),
          }));
          response = ['Thread/get', { accountId, list, state: 't', notFound: [] }, callId];
        } else if (name === 'Email/set') {
          const updated: Record<string, null> = {};
          for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
            const email = store.find((e) => e.id === id);
            if (!email) continue;
            for (const [path, value] of Object.entries(patch)) {
              if (path === 'mailboxIds') email.mailboxIds = { ...(value as Record<string, boolean>) };
              else if (path === 'keywords') email.keywords = { ...(value as Record<string, boolean>) };
              else {
                const [prop, key] = [path.slice(0, path.indexOf('/')), unescapePointer(path.slice(path.indexOf('/') + 1))];
                const target = (prop === 'mailboxIds' ? email.mailboxIds : email.keywords) as Record<string, boolean>;
                if (value) target[key] = true;
                else delete target[key];
              }
            }
            updated[id] = null;
          }
          const destroyed = ((args.destroy ?? []) as string[]).filter((id) => store.some((e) => e.id === id));
          accounts[accountId] = store.filter((e) => !destroyed.includes(e.id));
          response = ['Email/set', { accountId, updated, destroyed, newState: 'n' }, callId];
        } else {
          response = ['error', { type: 'unknownMethod' }, callId];
        }
      }
      byCallId.set(callId, response);
      responses.push(response);
    }
    return { methodResponses: responses, sessionState: 'session' };
  };

  /** Every method call sent so far, flattened across requests. */
  const calls = () => requests.flat();
  /** The calls of `name` sent so far. */
  const callsOf = (name: string) => calls().filter(([n]) => n === name);

  return { request, requests, calls, callsOf, failing, accounts };
}
