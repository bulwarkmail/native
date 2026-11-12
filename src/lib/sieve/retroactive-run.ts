// Running a saved filter rule over the mail already in a folder (webmail
// lib/filters/quick-rule-flow.ts planOnServer / executePlan): the server is
// asked for the candidates, the rule decides as its Sieve would, and the
// changes go out as Email/set patches.
import { jmapClient } from '../../api/jmap-client';
import { keywordPointer, mailboxPointer } from '../../api/patch-pointer';
import type { FilterRule } from './types';
import {
  planRetroactive, retroactiveSupport, retroProperties, retroQueryFilter, toRetroMessage,
  type RetroPlan, type RetroStep,
} from './retroactive';

const EMPTY_PLAN: RetroPlan = { ids: [], steps: [] };
/** No more than this many messages are read for one pass. */
const RETRO_LIMIT = 10000;

type Request = (calls: [string, Record<string, unknown>, string][]) => Promise<{ methodResponses: [string, Record<string, unknown>, string][] }>;

function request(): Request {
  return (calls) => jmapClient.request(calls) as ReturnType<Request>;
}

function methodError(name: string, body: Record<string, unknown>): Error {
  return new Error(typeof body.description === 'string' ? body.description : `${name} failed (${String(body.type ?? 'error')})`);
}

/** The candidates in `mailboxId` with the properties `rule` is decided on, newest first. */
async function queryCandidates(
  rule: FilterRule, mailboxId: string, accountId: string, send: Request,
): Promise<Array<Record<string, unknown>>> {
  const pageSize = Math.max(1, Math.min(500, jmapClient.getMaxObjectsInGet()));
  const seen = new Set<string>();
  const list: Array<Record<string, unknown>> = [];
  for (let position = 0; list.length < RETRO_LIMIT; position += pageSize) {
    const res = await send([
      ['Email/query', {
        accountId, filter: retroQueryFilter(rule, mailboxId),
        sort: [{ property: 'receivedAt', isAscending: false }], position, limit: pageSize,
      }, '0'],
      ['Email/get', {
        accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
        properties: ['id', ...retroProperties(rule)],
      }, '1'],
    ]);
    const [queryName, query] = res.methodResponses[0] ?? [];
    if (queryName !== 'Email/query') throw methodError('Email/query', query ?? {});
    const [getName, got] = res.methodResponses[1] ?? [];
    if (getName !== 'Email/get') throw methodError('Email/get', got ?? {});
    for (const email of (got.list as Array<Record<string, unknown>> | undefined) ?? []) {
      const id = String(email.id);
      if (seen.has(id)) continue;
      seen.add(id);
      list.push(email);
    }
    if (((query.ids as unknown[] | undefined) ?? []).length < pageSize) break;
  }
  return list;
}

/** What the rule would change in `mailboxId`; empty for a rule old mail can't be run through. */
export async function planRuleOnMailbox(
  rule: FilterRule, mailboxId: string, accountId: string = jmapClient.accountId, send: Request = request(),
): Promise<RetroPlan> {
  if (!retroactiveSupport(rule).ok) return EMPTY_PLAN;
  const records = await queryCandidates(rule, mailboxId, accountId, send);
  return planRetroactive(rule, records.map(toRetroMessage));
}

function stepPatch(step: RetroStep): Record<string, unknown> {
  switch (step.kind) {
    case 'mark_read': return { [keywordPointer('$seen')]: true };
    case 'keyword': return { [keywordPointer(step.keyword)]: true };
    case 'copy': return { [mailboxPointer(step.mailboxId)]: true };
    // Sieve files the message there and nowhere else.
    case 'move': return { mailboxIds: { [step.mailboxId]: true } };
  }
}

/** Carries out the plan's steps in order, in Email/set calls of at most maxObjectsInSet. */
export async function executeRetroPlan(
  plan: RetroPlan, accountId: string = jmapClient.accountId, send: Request = request(),
): Promise<void> {
  const size = Math.max(1, jmapClient.getMaxObjectsInSet());
  for (const step of plan.steps) {
    const patch = stepPatch(step);
    for (let i = 0; i < step.ids.length; i += size) {
      const ids = step.ids.slice(i, i + size);
      const res = await send([['Email/set', { accountId, update: Object.fromEntries(ids.map((id) => [id, patch])) }, '0']]);
      const [name, body] = res.methodResponses[0] ?? [];
      if (name !== 'Email/set') throw methodError('Email/set', body ?? {});
      const refused = Object.values((body.notUpdated as Record<string, Record<string, unknown>> | undefined) ?? {})[0];
      if (refused) throw methodError('Email/set', refused);
    }
  }
}

/** Runs `rule` over the mail in `mailboxId`; the number of messages it changed. */
export async function applyRuleToMailbox(
  rule: FilterRule, mailboxId: string, accountId: string = jmapClient.accountId, send: Request = request(),
): Promise<number> {
  const plan = await planRuleOnMailbox(rule, mailboxId, accountId, send);
  await executeRetroPlan(plan, accountId, send);
  return plan.ids.length;
}
