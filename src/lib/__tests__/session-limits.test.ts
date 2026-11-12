import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The organisation's idle sign-out and maximum session length (webmail
// lib/session-policy/limits.ts, session-timer.ts,
// components/session/session-timeout-guard.tsx; 6e5d8faec, 79c697a93).

vi.mock('../../stores/auth-store', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ activeAccountId: null as string | null, session: null as unknown })) };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useToastStore } from '../../stores/toast-store';
import {
  MAX_SKEW_MARGIN_MS,
  SESSION_END_RETRY_MS,
  endSessionForLimit,
  forgetActivity,
  lastActivity,
  noteActivity,
  noteSignedIn,
  resetSessionMemoryForTests,
  sessionEndDeferredUntil,
  sessionEndedWhileAway,
  sessionLimits,
  sessionState,
} from '../session-limits';
import { registerComposerFlush } from '../compose-flush-registry';
import { ADA, account, givenPolicy } from './org-policy-helpers';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-12T12:00:00Z');
const BOB = 'bob@example.org@mail.example.org';

const session = (idleMinutes: number, maxHours: number, warnSeconds = 60) => ({ idleMinutes, maxHours, warnSeconds });

beforeEach(async () => {
  await AsyncStorage.clear();
  resetSessionMemoryForTests();
  useToastStore.setState({ toasts: [] } as never);
});

describe('sessionLimits', () => {
  it('takes the shortest idle time and the first maximum to run out', () => {
    const limits = sessionLimits([
      { session: session(30, 8), signedInAt: NOW },
      { session: session(10, 0), signedInAt: NOW },
      { session: session(0, 4, 120), signedInAt: NOW + HOUR },
    ]);
    expect(limits.idle).toEqual({ minutes: 10, warnSeconds: 60 });
    expect(limits.max).toEqual({ at: NOW + 5 * HOUR - MAX_SKEW_MARGIN_MS, hours: 4, warnSeconds: 120 });
    expect(sessionLimits([{ session: session(0, 0) }])).toEqual({ idle: null, max: null });
  });

  it('warns before the deadline and expires at it', () => {
    const limits = sessionLimits([{ session: session(30, 0) }]);
    expect(sessionState(limits, NOW, NOW + 10 * MIN)).toMatchObject({ phase: 'active', kind: 'idle' });
    expect(sessionState(limits, NOW, NOW + 29.5 * MIN)).toMatchObject({ phase: 'warning', kind: 'idle' });
    expect(sessionState(limits, NOW, NOW + 30 * MIN)).toMatchObject({ phase: 'expired', kind: 'idle' });
    const both = sessionLimits([{ session: session(30, 1), signedInAt: NOW }]);
    expect(sessionState(both, NOW + 50 * MIN, NOW + 59.5 * MIN)).toMatchObject({ phase: 'expired', kind: 'max' });
  });
});

describe('a start after the app was away', () => {
  it('ends the session when the idle time ran out meanwhile', async () => {
    givenPolicy({ organisation: { session: { idleMinutes: 30 } } });
    noteActivity(NOW - 31 * MIN);
    await new Promise((r) => setTimeout(r, 0));
    resetSessionMemoryForTests();
    expect(await sessionEndedWhileAway(NOW)).toMatchObject({ kind: 'idle', limits: { idle: { minutes: 30 } } });
  });

  it('keeps a session used a moment ago', async () => {
    givenPolicy({ organisation: { session: { idleMinutes: 30 } } });
    noteActivity(NOW - 5 * MIN);
    expect(await sessionEndedWhileAway(NOW)).toBeNull();
  });

  it('refuses to restore a session past its maximum length, counted from the sign-in', async () => {
    givenPolicy({ organisation: { session: { maxHours: 8 } } });
    noteSignedIn(ADA, NOW - 9 * HOUR);
    noteActivity(NOW - MIN);
    expect(await sessionEndedWhileAway(NOW)).toMatchObject({ kind: 'max' });
    noteSignedIn(ADA, NOW - HOUR);
    expect(await sessionEndedWhileAway(NOW)).toBeNull();
  });

  it('starts a new sign-in after an idle sign-out with a fresh idle time', async () => {
    givenPolicy({ organisation: { session: { idleMinutes: 30 } } });
    noteActivity(NOW - 31 * MIN);
    expect(await sessionEndedWhileAway(NOW)).toMatchObject({ kind: 'idle' });
    // Signed in again: the activity before the sign-out no longer counts.
    noteSignedIn(ADA, NOW);
    expect(await sessionEndedWhileAway(NOW + MIN)).toBeNull();
  });

  it('forgets the activity at a sign-out, on the device too', async () => {
    givenPolicy({ organisation: { session: { idleMinutes: 30 } } });
    noteActivity(NOW - 31 * MIN);
    await new Promise((r) => setTimeout(r, 0));
    forgetActivity();
    expect(lastActivity()).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    resetSessionMemoryForTests();
    expect(await sessionEndedWhileAway(NOW)).toBeNull();
    expect(lastActivity()).toBeNull();
  });

  it('keeps the activity forgotten when the stored one is still being read', async () => {
    givenPolicy({ organisation: { session: { idleMinutes: 30 } } });
    noteActivity(NOW - 31 * MIN);
    await new Promise((r) => setTimeout(r, 0));
    resetSessionMemoryForTests();
    const reading = sessionEndedWhileAway(NOW);
    forgetActivity();
    expect(await reading).toBeNull();
  });

  it('counts an account signed in before the limit was known as signed in now', async () => {
    givenPolicy({ organisation: { session: { maxHours: 1 } } });
    expect(await sessionEndedWhileAway(NOW)).toBeNull();
    expect(await sessionEndedWhileAway(NOW + 2 * HOUR)).toMatchObject({ kind: 'max' });
  });

  it('follows the strictest of the signed-in accounts, not the refused ones', async () => {
    givenPolicy({
      organisation: { session: { idleMinutes: 0 } },
      scopes: [{ id: 'bob', match: { domains: ['example.org'] }, policy: { organisation: { session: { idleMinutes: 15 } } } }],
    }, { accounts: [account(ADA, 'ada@other.org', { email: 'ada@other.org' }), account(BOB, 'bob@example.org')] });
    noteActivity(NOW - 20 * MIN);
    expect(await sessionEndedWhileAway(NOW)).toMatchObject({ kind: 'idle' });
    givenPolicy({
      scopes: [{ id: 'bob', match: { domains: ['example.org'] }, policy: { organisation: { session: { idleMinutes: 15 } } } }],
    }, { accounts: [account(ADA, 'ada@other.org', { email: 'ada@other.org' }), account(BOB, 'bob@example.org', { needsSignIn: true })] });
    expect(await sessionEndedWhileAway(NOW)).toBeNull();
  });
});

describe('endSessionForLimit', () => {
  it('saves the open drafts first, then signs out through the app, and says why', async () => {
    givenPolicy({ organisation: { session: { idleMinutes: 20 } } });
    const order: string[] = [];
    const off = registerComposerFlush('c1', async () => { order.push('draft saved'); });
    await endSessionForLimit('idle', async () => { order.push('signed out'); });
    off();
    expect(order).toEqual(['draft saved', 'signed out']);
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.title).toBe('You were signed out after 20 minutes without activity.');
  });

  it('says when a draft could not be saved', async () => {
    givenPolicy({ organisation: { session: { maxHours: 2 } } });
    const off = registerComposerFlush('c1', async () => { throw new Error('offline'); });
    await endSessionForLimit('max', async () => undefined);
    off();
    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.type).toBe('warning');
    expect(toast?.message).toBe('One or more open messages could not be saved as drafts.');
  });

  it('says nothing and asks again shortly when the user stays signed in', async () => {
    givenPolicy({ organisation: { session: { maxHours: 2 } } });
    const before = Date.now();
    expect(await endSessionForLimit('max', async () => false)).toBe(false);
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(sessionEndDeferredUntil()).toBeGreaterThanOrEqual(before + SESSION_END_RETRY_MS);
    // Signed out the next time: said, and no longer waiting.
    expect(await endSessionForLimit('max', async () => true)).toBe(true);
    expect(useToastStore.getState().toasts.at(-1)?.title).toContain('maximum length of 2 hours');
    expect(sessionEndDeferredUntil()).toBe(0);
  });
});

describe('wiring', () => {
  it('checks the limits before a start restores the session, and notes each sign-in', () => {
    const auth = readFileSync(join(__dirname, '../../stores/auth-store.ts'), 'utf8');
    expect(auth).toMatch(/const ended = await limits\.sessionEndedWhileAway\(\)[\s\S]{0,120}if \(await get\(\)\.logoutAll\(\)\) \{\s*limits\.announceSessionEnd/);
    expect(auth).toContain("m.noteSignedIn(signedIn!.accountId)");
    const app = readFileSync(join(__dirname, '../../../App.tsx'), 'utf8');
    expect(app).toContain('<SessionTimeoutGuard />');
    // A sign-out the user turned down: the guard waits out the pause, then asks again.
    const guard = readFileSync(join(__dirname, '../../components/SessionTimeoutGuard.tsx'), 'utf8');
    expect(guard).toMatch(/const retryAt = sessionEndDeferredUntil\(\);\s*if \(at < retryAt\) \{\s*timer = setTimeout\(/);
    expect(guard).toMatch(/end\(next\.kind\)\.then\(\(signedOut\) => \{\s*if \(!signedOut && !disposed\) evaluate\(/);
    const compose = readFileSync(join(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
    expect(compose).toContain('registerComposerFlush(composeIdRef.current');
  });
});
