import { describe, it, expect } from 'vitest';
import { createAccountCapture } from '../captured-account';

describe('withCapturedAccount', () => {
  const setup = () => {
    let shown = 'a';
    let live = 'a';
    const withCaptured = createAccountCapture((id) => id === shown, () => new Error('switched'));
    return { withCaptured, switchTo: (id: string) => { shown = id; live = id; }, live: () => live };
  };

  it('writes when nothing switched', async () => {
    const s = setup();
    const writes: string[] = [];
    await s.withCaptured(() => ({ appAccountId: s.live() }), async (account, check) => {
      await Promise.resolve();
      check();
      writes.push(account.appAccountId!);
    });
    expect(writes).toEqual(['a']);
  });

  it('refuses a write after a switch between the capture and the write, whatever is live then', async () => {
    const s = setup();
    const writes: string[] = [];
    await expect(s.withCaptured(() => ({ appAccountId: s.live() }), async (account, check) => {
      await Promise.resolve();
      s.switchTo('b'); // a prompt was open while the app switched
      check();
      writes.push(account.appAccountId!);
    })).rejects.toThrow('switched');
    expect(writes).toEqual([]);
  });

  it('captures once', () => {
    const s = setup();
    let captures = 0;
    s.withCaptured(() => { captures++; return { appAccountId: 'a' }; }, (_a, check) => { check(); check(); });
    expect(captures).toBe(1);
  });
});
