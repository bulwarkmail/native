/**
 * What one run (or teardown) of one Android account and authority carries
 * through its phases.
 */
import type { AccountSyncPrefs, Authority, RunExtras } from '../types';
import type { JmapCaller } from '../jmap/caller';
import type { CapabilityAccount } from '../jmap/session';
import type { BatchWriter } from './batch';
import type { Checkpoints } from './checkpoint';
import type { EngineDeps, Tuning } from './deps';
import type { ProviderReader } from './provider';
import type { ReportBuilder } from './report';
import type { StateStore } from './sync-state';

export interface RunEnv {
  readonly deps: EngineDeps;
  readonly tuning: Tuning;
  /** A teardown only uploads (and never writes calendar rows). */
  readonly mode: 'sync' | 'teardown';
  readonly registryId: string;
  readonly accountName: string;
  readonly authority: Authority;
  readonly extras: RunExtras;
  readonly reader: ProviderReader;
  readonly writer: BatchWriter;
  readonly report: ReportBuilder;
  readonly checkpoints: Checkpoints;
  readonly store: StateStore;
  readonly jmap: JmapCaller;
  /** Accounts with the authority's capability, the primary first. */
  readonly accounts: CapabilityAccount[];
  readonly prefs: AccountSyncPrefs;
  now(): number;
  mintKey(taken?: Iterable<string>): string;
  mintUid(): string;
  sleep(ms: number): Promise<void>;
  log(message: string, detail?: unknown): void;
  recordKnownState(jmapAccountId: string, type: string, state: string): void;
}
