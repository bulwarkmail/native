import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { accountId: 'primary', connectedAccountId: 'primary', isConnected: true },
  RequestTimeoutError: class RequestTimeoutError extends Error {},
}));

import { undoSendLabel, undoSendSecondsLeft } from '../../stores/send-undo-store';

// The undo-send bar said "Sending in 10s…" for the whole delay: its text was
// built once from the delay. It counts down now. No React Native renderer in
// the test env, so the bar's wiring is checked in its source.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');
const HELD = { createdAt: 1_000_000, delaySeconds: 10 };

describe('undo-send countdown', () => {
  it('counts the seconds left down from the delay', () => {
    expect(undoSendSecondsLeft(HELD, HELD.createdAt)).toBe(10);
    expect(undoSendSecondsLeft(HELD, HELD.createdAt + 400)).toBe(10);
    expect(undoSendSecondsLeft(HELD, HELD.createdAt + 3_500)).toBe(7);
    expect(undoSendSecondsLeft(HELD, HELD.createdAt + 9_000)).toBe(1);
    // Never 0 or less, never more than the delay (a clock set back).
    expect(undoSendSecondsLeft(HELD, HELD.createdAt + 20_000)).toBe(1);
    expect(undoSendSecondsLeft(HELD, HELD.createdAt - 5_000)).toBe(10);
  });

  it('builds the bar text for the moment it is drawn', () => {
    expect(undoSendLabel(HELD, HELD.createdAt)).toBe('Sending in 10s…');
    expect(undoSendLabel(HELD, HELD.createdAt + 4_200)).toBe('Sending in 6s…');
  });

  it('redraws the bar text from a ticking clock', () => {
    const src = read('components/UndoSnackbar.tsx');
    expect(src).toMatch(/setInterval\(\(\) => setNow\(Date\.now\(\)\), \d+\)/);
    expect(src).toMatch(/\{shown\.send \? undoSendLabel\(shown\.send, now\) : shown\.label\}/);
  });
});
