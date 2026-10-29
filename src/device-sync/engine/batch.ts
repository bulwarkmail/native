/**
 * Packs item op groups into provider batches and applies them
 * (docs/device-sync.md, "SyncState", "Native module API", "Failure matrix"):
 *
 * - a group is never split; `refs` are rebased to the batch and the group's
 *   first op is its yield point, so the provider may commit between groups
 *   but never inside one (a group of 499 ops or more is the planner's to
 *   avoid: ContactsProvider refuses it);
 * - at most `maxOps` ops and about `maxBytes` per batch, as
 *   `estimateBatchBytes` counts them; groups that carry photo bytes travel
 *   alone (Binder budget);
 * - the SyncState op, when there is one, is the last op of the last batch
 *   and never a yield point: the stored state can't get ahead of its rows.
 *
 * A failed batch may have been committed up to a yield point the provider
 * took, so its groups are retried one by one: a group planned from the rows
 * as they are (`fresh`, a download) is planned again from a new read, any
 * other is sent again (its asserts make a retry of a committed group fail);
 * a group that fails an assert is re-read and re-planned up to `maxReplans`
 * times, then given up. `tooLarge` splits the batch; `permission` ends the
 * run.
 *
 * A group whose rows the SyncState describes (a group row: `groups`) carries
 * that `state` change: every batch that applies such a group, a retry
 * included, ends with a state op holding it.
 *
 * An item too big for one transaction comes as a chain (`OpGroup.next`): its
 * groups go in order, each in a batch of its own, between the batches of the
 * works before and after it; its `state` and `applied` go with the last. A
 * group of the chain that fails leaves the earlier ones written: after an
 * assert the item is read and planned again from them, else it is given up.
 */
import type { OpGroup } from '../planner';
import type { BatchFailure, OpResult, ProviderOp, ProviderPort } from '../types';
import { RunAbort } from './errors';
import { hasWrites } from './provider';
import type { StateChange, StateStore, Tail } from './sync-state';

export interface Work {
  group: OpGroup;
  /** The group applied; `results` are its ops' results (new row ids for inserts). */
  applied?(results: OpResult[]): void | Promise<void>;
  /** After an assert failure: read the item again and plan it again; null when nothing is left to write. */
  replan?(): Promise<Work | null>;
  /** Given up: the item's rows stay as they are. */
  failed?(reason: BatchFailure, message: string): void | Promise<void>;
  /** What the SyncState lists changes with these rows: stored by the batch that applies them. */
  state?: StateChange;
  /**
   * Planned from the rows as they are (a download), so `replan` gives the same group or its echo: after a failed
   * batch it is planned again instead of sent again (its asserts need not tell a committed group).
   */
  fresh?: boolean;
}

export interface BatchWriterOptions {
  maxOps: number;
  /** Per batch, as `estimateBatchBytes` counts them. */
  maxBytes: number;
  maxReplans: number;
}

/** Ops a provider takes up to and including one yield point (ContactsProvider throws at the 500th). */
export const MAX_OPS_PER_YIELD = 499;

/**
 * What ops weigh in the Binder transaction of an `applyBatch`, for the batch
 * budget and for planners that split big items: a Parcel carries strings as
 * UTF-16 (two bytes per character of their JSON) plus about 300 bytes per op
 * (URI, flags, value types, back-reference classes).
 */
export function estimateBatchBytes(ops: readonly ProviderOp[]): number {
  return 2 * JSON.stringify(ops).length + 300 * ops.length;
}

/** A group and the groups of its item that follow it (`next`), each without `next`. */
export function chainOf(group: OpGroup): OpGroup[] {
  const { next, ...first } = group;
  return [first, ...(next ?? [])];
}

/** Whether a group, or one of the groups after it, writes anything. */
export function chainHasWrites(group: OpGroup): boolean {
  return chainOf(group).some((g) => hasWrites(g.ops));
}

function carriesBlob(ops: readonly ProviderOp[]): boolean {
  return ops.some(
    (op) =>
      (op.op === 'insert' || op.op === 'update') &&
      Object.values(op.values).some((v) => v !== null && typeof v === 'object'),
  );
}

/** A group's ops at `offset` in a batch: refs rebased, the first op a yield point, no other. */
function placeGroup(ops: readonly ProviderOp[], offset: number): ProviderOp[] {
  return ops.map((op, i) => {
    const copy = { ...op } as ProviderOp & { yieldAllowed?: boolean };
    if (copy.op === 'insert' && copy.refs) {
      const refs: Record<string, number> = {};
      for (const [column, index] of Object.entries(copy.refs)) refs[column] = index + offset;
      copy.refs = refs;
    }
    if (i === 0) copy.yieldAllowed = true;
    else delete copy.yieldAllowed;
    return copy;
  });
}

export function buildBatch(groups: readonly OpGroup[], tailOp?: ProviderOp): ProviderOp[] {
  const out: ProviderOp[] = [];
  for (const group of groups) out.push(...placeGroup(group.ops, out.length));
  if (tailOp) {
    const { yieldAllowed: _never, ...last } = tailOp as ProviderOp & { yieldAllowed?: boolean };
    out.push(last as ProviderOp);
  }
  return out;
}

/** Prepends ops to a group (e.g. an engine-side assert), shifting the group's refs; the groups after it stay. */
export function prependOps(group: OpGroup, ops: ProviderOp[]): OpGroup {
  return { ...group, ops: [...ops, ...placeGroup(group.ops, ops.length).map(stripYield)] };
}

/** One group running `first` then `second` atomically (then the groups after `second`). */
export function concatGroups(ref: string, first: OpGroup, second: OpGroup): OpGroup {
  return {
    ref,
    ops: [...first.ops.map(stripYield), ...placeGroup(second.ops, first.ops.length).map(stripYield)],
    ...(second.next ? { next: second.next } : {}),
  };
}

/** Appends ops to the last group of a chain (e.g. clearing a poison marker once the item is written). */
export function appendToLast(group: OpGroup, ops: ProviderOp[]): OpGroup {
  if (!ops.length) return group;
  if (!group.next?.length) return { ...group, ops: [...group.ops, ...ops] };
  const next = [...group.next];
  const last = next[next.length - 1];
  next[next.length - 1] = { ...last, ops: [...last.ops, ...ops] };
  return { ...group, next };
}

function stripYield(op: ProviderOp): ProviderOp {
  const { yieldAllowed: _y, ...rest } = op as ProviderOp & { yieldAllowed?: boolean };
  return rest as ProviderOp;
}

export class BatchWriter {
  /** Batches sent, for tests and logs. */
  batchesSent = 0;

  constructor(
    private readonly port: ProviderPort,
    private readonly options: BatchWriterOptions,
    /** Where the `state` of works goes; without it, it is ignored. */
    private readonly store?: StateStore,
  ) {}

  /**
   * Applies the works in order; `tail` (the SyncState op) goes last, after
   * every group of `works` was applied or given up.
   */
  async write(works: readonly Work[], tail?: Tail): Promise<void> {
    let run: Work[] = [];
    for (const work of works) {
      if (!chainHasWrites(work.group)) continue;
      if (!work.group.next?.length) {
        run.push(work);
        continue;
      }
      await this.writeRun(run);
      run = [];
      await this.applyChain(work, 0);
    }
    await this.writeRun(run, tail);
  }

  /** Works of one group each, packed into batches. */
  private async writeRun(todo: readonly Work[], tail?: Tail): Promise<void> {
    const batches = this.pack(todo);
    if (batches.length === 0) {
      if (tail) await this.applyTail(tail);
      return;
    }
    for (let i = 0; i < batches.length; i++) {
      const last = i === batches.length - 1;
      const batch = batches[i];
      // A photo batch is already at the Binder budget, and a group that fills a yield window leaves no room:
      // the state op goes alone.
      const photo = batch.length === 1 && carriesBlob(batch[0].group.ops);
      const full = batch[batch.length - 1].group.ops.length >= MAX_OPS_PER_YIELD;
      const tailHere = last && tail && !photo && !full ? tail : undefined;
      await this.applyBatch(batch, tailHere);
      if (last && tail && !tailHere) await this.applyTail(tail);
    }
  }

  private pack(works: readonly Work[]): Work[][] {
    const batches: Work[][] = [];
    let current: Work[] = [];
    let ops = 0;
    let bytes = 0;
    const flush = () => {
      if (current.length) batches.push(current);
      current = [];
      ops = 0;
      bytes = 0;
    };
    for (const work of works) {
      if (carriesBlob(work.group.ops)) {
        flush();
        batches.push([work]);
        continue;
      }
      const n = work.group.ops.length;
      const b = estimateBatchBytes(work.group.ops);
      if (current.length && (ops + n > this.options.maxOps || bytes + b > this.options.maxBytes)) flush();
      current.push(work);
      ops += n;
      bytes += b;
    }
    flush();
    return batches;
  }

  private async send(ops: ProviderOp[]) {
    this.batchesSent++;
    const result = await this.port.applyBatch(ops);
    if (!result.ok) {
      if (result.reason === 'permission') throw new RunAbort('permission', result.message);
      // The native side refused an op outside our account: an engine bug, never retried.
      if (result.reason === 'scope') throw new Error(`Provider refused an op: ${result.message}`);
    }
    return result;
  }

  /** The works' state changes go into the state op of the batch being sent: `tail`, or one of its own. */
  private stage(works: readonly Work[], tail?: Tail): { staged: Work[]; tail?: Tail } {
    const store = this.store;
    const staged = store ? works.filter((w) => w.state) : [];
    for (const work of staged) store!.stage(work, work.state!);
    return { staged, tail: tail ?? (staged.length ? store!.tail(() => undefined) : undefined) };
  }

  private unstage(staged: readonly Work[]): void {
    for (const work of staged) this.store!.unstage(work);
  }

  private async applyBatch(works: Work[], tail?: Tail): Promise<void> {
    const stated = this.stage(works, tail);
    let result;
    try {
      result = await this.send(buildBatch(works.map((w) => w.group), stated.tail?.op()));
    } finally {
      this.unstage(stated.staged);
    }
    if (result.ok) {
      let offset = 0;
      for (const work of works) {
        const n = work.group.ops.length;
        await work.applied?.(result.results.slice(offset, offset + n));
        offset += n;
      }
      stated.tail?.applied();
      return;
    }
    if (result.reason === 'tooLarge' && works.length > 1) {
      const middle = Math.ceil(works.length / 2);
      await this.applyBatch(works.slice(0, middle));
      await this.applyBatch(works.slice(middle), tail);
      return;
    }
    if (works.length === 1 && !tail) {
      await this.retryAlone(works[0], result.reason, result.message);
      return;
    }
    for (const work of works) {
      if (work.fresh && work.replan) {
        const next = await work.replan();
        if (next) await this.applyAlone(next, 1);
      } else {
        await this.applyAlone(work, 0);
      }
    }
    if (tail) await this.applyTail(tail);
  }

  /**
   * An item's chain of groups, each in a batch of its own and so committed
   * whole or not at all; the item's state and `applied` go with the last.
   */
  private async applyChain(work: Work, attempt: number): Promise<void> {
    const groups = chainOf(work.group).filter((g) => hasWrites(g.ops));
    const results: OpResult[] = [];
    for (let i = 0; i < groups.length; i++) {
      const last = i === groups.length - 1;
      const stated = last ? this.stage([work]) : { staged: [], tail: undefined };
      let result;
      try {
        result = await this.send(buildBatch([groups[i]], stated.tail?.op()));
      } finally {
        this.unstage(stated.staged);
      }
      if (!result.ok) {
        // The groups before it are written: planned again from them, never sent again as they are.
        await this.retryAlone(work, result.reason, result.message, attempt);
        return;
      }
      results.push(...result.results.slice(0, groups[i].ops.length));
      if (last) {
        await work.applied?.(results);
        stated.tail?.applied();
      }
    }
  }

  private async applyAlone(work: Work, attempt: number): Promise<void> {
    if (work.group.next?.length) return this.applyChain(work, attempt);
    if (!hasWrites(work.group.ops)) return;
    const stated = this.stage([work]);
    let result;
    try {
      result = await this.send(buildBatch([work.group], stated.tail?.op()));
    } finally {
      this.unstage(stated.staged);
    }
    if (result.ok) {
      await work.applied?.(result.results.slice(0, work.group.ops.length));
      stated.tail?.applied();
      return;
    }
    await this.retryAlone(work, result.reason, result.message, attempt);
  }

  private async retryAlone(work: Work, reason: BatchFailure, message: string, attempt = 0): Promise<void> {
    if (reason === 'assert' && work.replan && attempt < this.options.maxReplans) {
      const next = await work.replan();
      if (next) await this.applyAlone(next, attempt + 1);
      return;
    }
    await work.failed?.(reason, message);
  }

  private async applyTail(tail: Tail): Promise<void> {
    const result = await this.send([...buildBatch([], tail.op())]);
    if (!result.ok) throw new Error(`Could not store the sync state: ${result.reason} ${result.message}`);
    tail.applied();
  }
}
