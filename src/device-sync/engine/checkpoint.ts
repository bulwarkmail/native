/**
 * Checkpoints sit between chunks and phases (docs/device-sync.md, "A sync
 * run"): the run stops cleanly when the framework cancelled it or its time
 * is nearly up, keeps SyncManager's traffic monitor happy during long local
 * phases (it cancels a sync with no network traffic for 60 s), and lets the
 * JS thread breathe so the UI keeps rendering when it shares the runtime.
 */
import type { JmapCaller } from '../jmap/caller';
import { StopRun } from './errors';

export interface CheckpointOptions {
  now(): number;
  /** Epoch ms by which the run must have finished. */
  deadline: number;
  /** Stop starting work this long before the deadline. */
  marginMs: number;
  echoAfterMs: number;
  isCancelled(): Promise<boolean>;
  yieldThread(): Promise<void>;
}

export class Checkpoints {
  private jmap: JmapCaller | null = null;
  /** Test hook: runs at every checkpoint (crash injection). */
  onCheckpoint?: (label: string) => void | Promise<void>;

  constructor(private readonly options: CheckpointOptions) {}

  attach(jmap: JmapCaller): void {
    this.jmap = jmap;
  }

  budgetMs(): number {
    return this.options.deadline - this.options.now();
  }

  /** Throws StopRun when the run must end here. */
  async check(label = ''): Promise<void> {
    await this.onCheckpoint?.(label);
    if (this.budgetMs() < this.options.marginMs) throw new StopRun('deadline');
    if (await this.options.isCancelled()) throw new StopRun('cancelled');
    if (this.jmap && this.jmap.idleMs() >= this.options.echoAfterMs) await this.jmap.echo();
    await this.options.yieldThread();
  }

  /** Throws StopRun('deadline') unless at least `ms` of budget remain (a create batch needs two request timeouts). */
  requireBudget(ms: number): void {
    if (this.budgetMs() < ms) throw new StopRun('deadline');
  }

  /** Keeps traffic flowing during a long local phase without the other checks. */
  async keepAlive(): Promise<void> {
    if (this.jmap && this.jmap.idleMs() >= this.options.echoAfterMs) await this.jmap.echo();
  }
}
