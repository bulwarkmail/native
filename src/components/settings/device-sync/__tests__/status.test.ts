import { describe, it, expect } from 'vitest';
import { translate, type MessageParams } from '../../../../i18n';
import { CALENDAR_AUTHORITY, CONTACTS_AUTHORITY, type RunStatus } from '../../../../device-sync/types';
import { describeSyncStatus, relativeTime, type StatusInput } from '../status';

const t = (key: string, fallback?: string, params?: MessageParams) => translate('en', key, fallback, params);

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

const run = (outcome: RunStatus['outcome'], extra: Partial<RunStatus> = {}): RunStatus => ({
  at: NOW - 5 * 60_000,
  outcome,
  durationMs: 100,
  conflicts: 0,
  itemErrors: 0,
  stats: {
    downloaded: { created: 0, updated: 0, deleted: 0 },
    uploaded: { created: 0, updated: 0, deleted: 0 },
    entries: 0,
    skipped: 0,
  },
  ...extra,
});

const base: StatusInput = {
  authority: CONTACTS_AUTHORITY,
  on: true,
  paused: false,
  removed: false,
  permitted: true,
  syncing: false,
  now: NOW,
};

describe('describeSyncStatus', () => {
  it('says off, or that the account was removed in Android settings', () => {
    expect(describeSyncStatus({ ...base, on: false }, t)).toEqual({ text: 'Off', tone: 'muted' });
    expect(describeSyncStatus({ ...base, on: false, removed: true }, t).tone).toBe('warning');
  });

  it('puts a revoked permission first, with a way to grant it again', () => {
    const line = describeSyncStatus({ ...base, permitted: false, lastRun: run('ok') }, t);
    expect(line).toMatchObject({ tone: 'error', action: 'grantAccess' });
    expect(line.text).toContain('contacts');
    expect(describeSyncStatus({ ...base, authority: CALENDAR_AUTHORITY, permitted: false }, t).text).toContain('calendars');
  });

  it('says when Android paused the account', () => {
    expect(describeSyncStatus({ ...base, on: false, paused: true }, t))
      .toEqual({ text: 'Paused in Android settings', tone: 'warning' });
  });

  it('shows a running sync, then when it last synced', () => {
    expect(describeSyncStatus({ ...base, syncing: true, lastRun: run('ok') }, t).text).toBe('Syncing…');
    expect(describeSyncStatus({ ...base, lastRun: run('ok') }, t)).toEqual({ text: 'Synced 5 min ago', tone: 'muted' });
    expect(describeSyncStatus({ ...base, lastRun: run('ok', { itemErrors: 2 }) }, t)).toEqual({
      text: 'Synced 5 min ago · 2 items could not be synced.',
      tone: 'warning',
    });
    expect(describeSyncStatus(base, t).text).toBe('Waiting for the first sync');
  });

  it('offers what fixes a failed run', () => {
    expect(describeSyncStatus({ ...base, lastRun: run('auth') }, t)).toMatchObject({ tone: 'error', action: 'signIn' });
    expect(describeSyncStatus({ ...base, lastRun: run('tooManyDeletions') }, t)).toMatchObject({ action: 'reviewDeletions' });
    expect(describeSyncStatus({ ...base, lastRun: run('permission') }, t)).toMatchObject({ action: 'grantAccess' });
    expect(describeSyncStatus({ ...base, lastRun: run('io') }, t).text).toBe('Could not reach the server 5 min ago. Android tries again.');
    expect(describeSyncStatus({ ...base, lastRun: run('internal', { message: 'Boom' }) }, t).text)
      .toBe('The last sync failed: Boom');
    // A run that found sync off says nothing new.
    expect(describeSyncStatus({ ...base, lastRun: run('disabled') }, t).text).toBe('Waiting for the next sync');
  });
});

describe('relativeTime', () => {
  it('counts minutes, hours and days', () => {
    expect(relativeTime(NOW - 10_000, NOW, t)).toBe('just now');
    expect(relativeTime(NOW - 3 * 3600_000, NOW, t)).toBe('3 h ago');
    expect(relativeTime(NOW - 2 * 86_400_000, NOW, t)).toBe('2 d ago');
  });
});
