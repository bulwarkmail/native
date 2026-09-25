// A small in-memory Stalwart for EmailSubmission tests. It models what the
// submission cleanup depends on, per version (probed on the 0.16.23 and 1.0
// test servers, older versions from the source):
// - the create answer: `{id}` before 0.16.10, undoStatus "final" on
//   0.16.10-0.16.16 even for a held send, "pending" from 0.16.17 and on 1.0;
// - EmailSubmission/get: undoStatus computed from the queue - pending while
//   held or retrying, final once delivered, canceled - at any age by id;
// - EmailSubmission/query: only records whose sendAt is at most three days
//   back (open-ended into the future), oldest sendAt first, `total` only with
//   calculateTotal, the before/after/undoStatus filters and operators;
// - EmailSubmission/set: 1.0's per-account limit, which counts every record
//   and refuses creates with overQuota; cancel of a held send; destroy, with
//   notFound for a record that is gone;
// - EmailSubmission/changes from "n": the whole log in pages of maxChanges,
//   a record created and destroyed within it left out;
// - Email/set, Email/import and Email/get, just enough for the send paths.
// It records the one thing the client must never do - destroy a submission
// that get reports as pending with sendAt in the future - in `violations`.

import type { JMAPMethodCall } from '../types';

export type StalwartVersion = '0.16.6' | '0.16.10' | '0.16.23' | '1.0';

export const OVER_QUOTA_DESCRIPTION =
  'There are too many email submissions, please delete some before adding a new one.';

const DAY_MS = 86_400_000;

interface Submission {
  id: string;
  seq: number;
  emailId: string;
  identityId: string;
  sendAt: number;
  canceled: boolean;
  /** Still in the queue with sendAt passed (a delivery being retried). */
  retrying: boolean;
  envelope?: unknown;
}

interface StoredEmail {
  id: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  subject?: string;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  from?: unknown;
}

export interface SeedSubmission {
  sendAt: number;
  status: 'pending' | 'final' | 'canceled';
  /** A pending record whose sendAt has passed (retrying). */
  retrying?: boolean;
  emailId?: string;
}

type Response = [string, Record<string, any>, string];

function utcDate(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function createFakeSubmissionServer(options: {
  version: StalwartVersion;
  /** 1.0's `maxSubmissions` per account. */
  limit?: number;
  /** The server's cap on one /changes answer. */
  maxChanges?: number;
  /** Leave `total` out of query answers, as a server may. */
  omitTotal?: boolean;
}) {
  const { version } = options;
  const limit = options.limit ?? 500;
  const maxChanges = options.maxChanges ?? 5000;
  const accounts = new Map<string, Map<string, Submission>>();
  const changeLogs = new Map<string, Array<{ id: string; kind: 'created' | 'updated' | 'destroyed' }>>();
  const emails = new Map<string, StoredEmail>();
  const requests: Array<{ calls: JMAPMethodCall[]; using?: string[]; responses: Response[] }> = [];
  const violations: string[] = [];
  let seq = 0;
  let emailSeq = 0;
  /** Makes the next Email/set create fail with this SetError. */
  let emailCreateFailure: { type: string; description?: string } | null = null;

  const recordsOf = (accountId: string) => {
    let records = accounts.get(accountId);
    if (!records) {
      records = new Map();
      accounts.set(accountId, records);
    }
    return records;
  };
  const logOf = (accountId: string) => {
    let log = changeLogs.get(accountId);
    if (!log) {
      log = [];
      changeLogs.set(accountId, log);
    }
    return log;
  };

  function status(s: Submission): 'pending' | 'final' | 'canceled' {
    if (s.canceled) return 'canceled';
    if (s.retrying) return 'pending';
    return s.sendAt > Date.now() ? 'pending' : 'final';
  }

  function addSubmission(accountId: string, fields: Omit<Submission, 'id' | 'seq'>): Submission {
    seq += 1;
    const submission: Submission = { id: `s${seq}`, seq, ...fields };
    recordsOf(accountId).set(submission.id, submission);
    logOf(accountId).push({ id: submission.id, kind: 'created' });
    return submission;
  }

  function view(s: Submission, properties?: string[]): Record<string, unknown> {
    const full: Record<string, unknown> = {
      id: s.id,
      emailId: s.emailId,
      identityId: s.identityId,
      threadId: `t-${s.emailId}`,
      sendAt: utcDate(s.sendAt),
      undoStatus: status(s),
      envelope: s.envelope ?? null,
    };
    if (!properties) return full;
    return Object.fromEntries(['id', ...properties].map((p) => [p, full[p]]));
  }

  function matches(s: Submission, filter: Record<string, any> | undefined): boolean {
    if (!filter) return true;
    if ('operator' in filter) {
      const results = (filter.conditions as Array<Record<string, any>>).map((c) => matches(s, c));
      if (filter.operator === 'AND') return results.every(Boolean);
      if (filter.operator === 'OR') return results.some(Boolean);
      return !results.some(Boolean);
    }
    return Object.entries(filter).every(([key, value]) => {
      switch (key) {
        case 'before': return s.sendAt < Date.parse(value);
        case 'after': return s.sendAt > Date.parse(value);
        // The stored status: canceled is stored, pending/final are not
        // told apart until get (0.16 matches the stored status).
        case 'undoStatus': return value === 'canceled' ? s.canceled : !s.canceled;
        default: throw new Error(`fake server: unsupported filter ${key}`);
      }
    });
  }

  function createdAnswer(s: Submission): Record<string, unknown> {
    if (version === '0.16.6') return { id: s.id };
    if (version === '0.16.10') return { id: s.id, sendAt: utcDate(s.sendAt), undoStatus: 'final' };
    return { id: s.id, sendAt: utcDate(s.sendAt), undoStatus: 'pending' };
  }

  function holdSeconds(create: Record<string, any>): number {
    const hold = create.envelope?.mailFrom?.parameters?.HOLDFOR;
    return hold ? Number(hold) : 0;
  }

  function submissionSet(args: Record<string, any>, callId: string, createdEmails: Map<string, string>): Response[] {
    const accountId = args.accountId as string;
    const records = recordsOf(accountId);
    const body: Record<string, any> = { accountId, newState: `s${seq}` };
    const extra: Response[] = [];
    if (args.create) {
      // 1.0 counts once per call, before its creates (set.rs:123-136).
      const used = records.size;
      let accepted = 0;
      for (const [creationId, create] of Object.entries(args.create as Record<string, Record<string, any>>)) {
        if (version === '1.0' && used + accepted >= limit) {
          (body.notCreated ??= {})[creationId] = { type: 'overQuota', description: OVER_QUOTA_DESCRIPTION };
          continue;
        }
        const rawEmailId = String(create.emailId);
        const emailId = rawEmailId.startsWith('#') ? createdEmails.get(rawEmailId.slice(1)) : rawEmailId;
        if (!emailId || !emails.has(emailId)) {
          (body.notCreated ??= {})[creationId] = { type: 'invalidProperties', properties: ['emailId'] };
          continue;
        }
        accepted += 1;
        const submission = addSubmission(accountId, {
          emailId,
          identityId: String(create.identityId),
          sendAt: Date.now() + holdSeconds(create) * 1000,
          canceled: false,
          retrying: false,
          envelope: create.envelope,
        });
        (body.created ??= {})[creationId] = createdAnswer(submission);
        const update = args.onSuccessUpdateEmail?.[`#${creationId}`];
        if (update) {
          const email = emails.get(emailId)!;
          if (update.mailboxIds) email.mailboxIds = update.mailboxIds;
          if ('keywords/$draft' in update) delete email.keywords.$draft;
          extra.push(['Email/set', { accountId, updated: { [emailId]: null } }, callId]);
        }
      }
    }
    for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, any>>)) {
      const s = records.get(id);
      if (!s) {
        (body.notUpdated ??= {})[id] = { type: 'notFound' };
      } else if (patch.undoStatus === 'canceled' && status(s) === 'pending' && !s.retrying) {
        s.canceled = true;
        logOf(accountId).push({ id, kind: 'updated' });
        (body.updated ??= {})[id] = null;
      } else {
        (body.notUpdated ??= {})[id] = { type: 'cannotUnsend', description: 'The message has already been sent.' };
      }
    }
    for (const id of (args.destroy ?? []) as string[]) {
      const s = records.get(id);
      if (!s) {
        (body.notDestroyed ??= {})[id] = { type: 'notFound' };
        continue;
      }
      if (status(s) === 'pending' && s.sendAt > Date.now()) violations.push(id);
      records.delete(id);
      logOf(accountId).push({ id, kind: 'destroyed' });
      (body.destroyed ??= []).push(id);
    }
    body.newState = `s${seq}`;
    return [['EmailSubmission/set', body, callId], ...extra];
  }

  function submissionChanges(args: Record<string, any>, callId: string): Response {
    const accountId = args.accountId as string;
    const log = logOf(accountId);
    const since = String(args.sinceState);
    if (since !== 'n' && !since.startsWith('r')) {
      return ['error', { type: 'cannotCalculateChanges' }, callId];
    }
    // Net changes over the whole log, one entry per id.
    const created = new Map<string, true>();
    const updated = new Map<string, true>();
    const destroyed = new Map<string, true>();
    for (const { id, kind } of log) {
      if (kind === 'created') created.set(id, true);
      else if (kind === 'updated') {
        if (!created.has(id)) updated.set(id, true);
      } else if (created.has(id)) created.delete(id);
      else {
        updated.delete(id);
        destroyed.set(id, true);
      }
    }
    const all: Array<['created' | 'updated' | 'destroyed', string]> = [
      ...[...created.keys()].map((id) => ['created', id] as ['created', string]),
      ...[...updated.keys()].map((id) => ['updated', id] as ['updated', string]),
      ...[...destroyed.keys()].map((id) => ['destroyed', id] as ['destroyed', string]),
    ];
    const offset = since === 'n' ? 0 : Number(since.slice(1));
    const pageSize = Math.min(maxChanges, (args.maxChanges as number | undefined) ?? maxChanges);
    const page = all.slice(offset, offset + pageSize);
    const hasMoreChanges = offset + pageSize < all.length;
    return ['EmailSubmission/changes', {
      accountId,
      oldState: since,
      newState: hasMoreChanges ? `r${offset + pageSize}` : `s${seq}`,
      hasMoreChanges,
      created: page.filter(([kind]) => kind === 'created').map(([, id]) => id),
      updated: page.filter(([kind]) => kind === 'updated').map(([, id]) => id),
      destroyed: page.filter(([kind]) => kind === 'destroyed').map(([, id]) => id),
    }, callId];
  }

  async function request(calls: JMAPMethodCall[], using?: string[]): Promise<{ methodResponses: Response[] }> {
    const responses: Response[] = [];
    requests.push({ calls, using, responses });
    const createdEmails = new Map<string, string>();
    for (const [name, rawArgs, callId] of calls) {
      const args = rawArgs as Record<string, any>;
      const accountId = args.accountId as string;
      if (name === 'Email/set') {
        const body: Record<string, any> = { accountId };
        for (const [creationId, create] of Object.entries((args.create ?? {}) as Record<string, Record<string, any>>)) {
          if (emailCreateFailure) {
            (body.notCreated ??= {})[creationId] = emailCreateFailure;
            emailCreateFailure = null;
            continue;
          }
          emailSeq += 1;
          const id = `e${emailSeq}`;
          emails.set(id, {
            id,
            mailboxIds: { ...(create.mailboxIds ?? {}) },
            keywords: { ...(create.keywords ?? {}) },
            subject: create.subject,
            to: create.to,
            cc: create.cc,
            bcc: create.bcc,
            from: create.from,
          });
          createdEmails.set(creationId, id);
          (body.created ??= {})[creationId] = { id };
        }
        for (const id of (args.destroy ?? []) as string[]) {
          if (emails.delete(id)) (body.destroyed ??= []).push(id);
          else (body.notDestroyed ??= {})[id] = { type: 'notFound' };
        }
        responses.push(['Email/set', body, callId]);
      } else if (name === 'Email/import') {
        const body: Record<string, any> = { accountId };
        for (const [creationId, item] of Object.entries(args.emails as Record<string, Record<string, any>>)) {
          emailSeq += 1;
          const id = `e${emailSeq}`;
          emails.set(id, { id, mailboxIds: { ...(item.mailboxIds ?? {}) }, keywords: { ...(item.keywords ?? {}) } });
          createdEmails.set(creationId, id);
          (body.created ??= {})[creationId] = { id };
        }
        responses.push(['Email/import', body, callId]);
      } else if (name === 'Email/get') {
        const list = ((args.ids ?? []) as string[]).flatMap((id) => {
          const email = emails.get(id);
          return email ? [email] : [];
        });
        responses.push(['Email/get', { accountId, list, notFound: [] }, callId]);
      } else if (name === 'EmailSubmission/query') {
        const records = [...recordsOf(accountId).values()]
          .filter((s) => s.sendAt >= Date.now() - 3 * DAY_MS)
          .filter((s) => matches(s, args.filter))
          .sort((a, b) => a.sendAt - b.sendAt || a.seq - b.seq);
        const position = (args.position as number | undefined) ?? 0;
        const pageLimit = (args.limit as number | undefined) ?? records.length;
        const body: Record<string, any> = {
          accountId,
          queryState: `s${seq}`,
          canCalculateChanges: true,
          position,
          ids: records.slice(position, position + pageLimit).map((s) => s.id),
        };
        if (args.calculateTotal && !options.omitTotal) body.total = records.length;
        responses.push(['EmailSubmission/query', body, callId]);
      } else if (name === 'EmailSubmission/get') {
        const ref = args['#ids'] as { resultOf: string } | undefined;
        const ids = ref
          ? (responses.find(([, , id]) => id === ref.resultOf)?.[1].ids as string[])
          : (args.ids as string[]);
        const records = recordsOf(accountId);
        responses.push(['EmailSubmission/get', {
          accountId,
          state: `s${seq}`,
          list: ids.flatMap((id) => {
            const s = records.get(id);
            return s ? [view(s, args.properties as string[] | undefined)] : [];
          }),
          notFound: ids.filter((id) => !records.has(id)),
        }, callId]);
      } else if (name === 'EmailSubmission/set') {
        responses.push(...submissionSet(args, callId, createdEmails));
      } else if (name === 'EmailSubmission/changes') {
        responses.push(submissionChanges(args, callId));
      } else {
        throw new Error(`fake server: unexpected ${name}`);
      }
    }
    return { methodResponses: responses };
  }

  return {
    request,
    requests,
    violations,
    emails,
    /** Records of an account, whatever their age, as get would report them. */
    submissions(accountId = 'acc-1') {
      return [...recordsOf(accountId).values()].map((s) => ({ id: s.id, sendAt: s.sendAt, undoStatus: status(s) }));
    },
    seed(accountId: string, items: SeedSubmission[]): string[] {
      return items.map((item) => {
        const emailId = item.emailId ?? `seed-${seq + 1}`;
        if (!emails.has(emailId)) emails.set(emailId, { id: emailId, mailboxIds: { sent: true }, keywords: {} });
        return addSubmission(accountId, {
          emailId,
          identityId: 'id-1',
          sendAt: item.sendAt,
          canceled: item.status === 'canceled',
          retrying: item.status === 'pending' && item.sendAt <= Date.now(),
        }).id;
      });
    },
    failNextEmailCreate(failure: { type: string; description?: string }) {
      emailCreateFailure = failure;
    },
    /** The method names of every request, in order. */
    methods(): string[][] {
      return requests.map(({ calls }) => calls.map(([name]) => name));
    },
  };
}

export type FakeSubmissionServer = ReturnType<typeof createFakeSubmissionServer>;
