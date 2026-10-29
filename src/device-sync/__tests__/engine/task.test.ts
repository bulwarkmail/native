// The headless task entry: every run ends with finishRun and nothing
// escapes it (docs/device-sync.md, "The Android shell").

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../native', () => ({
  createProviderPort: vi.fn(),
  finishRun: vi.fn(async () => true),
  getSyncSettings: vi.fn(async () => ({
    masterAutomatic: true,
    authorities: { 'com.android.contacts': { automatic: false, syncable: 1, periodicSeconds: 0, active: false, pending: false } },
  })),
  isRunCancelled: vi.fn(async () => false),
  showSyncProblem: vi.fn(async () => undefined),
}));

import * as native from '../../native';
import { emptyStats } from '../../engine/report';
import { createTaskDeps, runDeviceSyncTask, teardownAuthority } from '../../task';
import { useDeviceSyncStore } from '../../../stores/device-sync-store';
import type { RunPayload } from '../../types';

const payload: RunPayload = {
  runId: 'r1',
  accountName: 'alice@example.com',
  registryId: 'alice@mail.example.com',
  authority: 'com.android.contacts',
  extras: {},
  deadline: Date.now() + 60_000,
};

describe('device sync task', () => {
  beforeEach(() => {
    vi.mocked(native.finishRun).mockClear();
  });

  it('hands the report to the adapter before settling, and records the status', async () => {
    await runDeviceSyncTask(payload);

    expect(native.finishRun).toHaveBeenCalledWith('r1', expect.objectContaining({ v: 1, runId: 'r1', outcome: 'disabled' }));
    expect(useDeviceSyncStore.getState().accounts['alice@mail.example.com']?.lastRun?.['com.android.contacts']).toMatchObject({
      outcome: 'disabled',
    });
  });

  it('reads back the status it records, for a run that did nothing to keep', async () => {
    const deps = createTaskDeps();
    const status = { at: 5, outcome: 'ok' as const, durationMs: 3, conflicts: 1, itemErrors: 2, stats: emptyStats() };

    await deps.recordStatus('bob@mail.example.com', 'com.android.calendar', status);

    await expect(deps.lastStatus('bob@mail.example.com', 'com.android.calendar')).resolves.toEqual(status);
    await expect(deps.lastStatus('bob@mail.example.com', 'com.android.contacts')).resolves.toBeUndefined();
    await expect(deps.lastStatus('nobody@mail.example.com', 'com.android.calendar')).resolves.toBeUndefined();
  });

  it('reports a failure instead of throwing, and survives a refused finishRun', async () => {
    vi.mocked(native.getSyncSettings).mockRejectedValueOnce(new Error('module gone'));
    vi.mocked(native.finishRun).mockRejectedValueOnce(new Error('bridge down'));

    await expect(runDeviceSyncTask({ ...payload, runId: 'r2' })).resolves.toBeUndefined();

    expect(native.finishRun).toHaveBeenCalledWith('r2', expect.objectContaining({ outcome: 'internal', message: 'module gone' }));
  });

  it('ignores a payload without a run', async () => {
    await runDeviceSyncTask({} as RunPayload);
    expect(native.finishRun).not.toHaveBeenCalled();
  });

  it('exports the teardown the app calls', () => {
    expect(teardownAuthority).toBeTypeOf('function');
    expect(teardownAuthority.length).toBe(4);
  });
});
