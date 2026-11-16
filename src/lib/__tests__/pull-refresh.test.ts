import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createPullRefresh } from '../pull-refresh';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createPullRefresh', () => {
  it('shows the spinner from the pull until the list has reloaded', async () => {
    const onChange = vi.fn();
    const load = deferred();
    const pull = createPullRefresh(onChange);
    pull.run(() => load.promise);
    expect(onChange).toHaveBeenLastCalledWith(true);
    load.resolve();
    await load.promise;
    await Promise.resolve();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('takes the spinner away when the reload fails', async () => {
    const onChange = vi.fn();
    const load = deferred();
    const pull = createPullRefresh(onChange);
    pull.run(() => load.promise);
    load.reject(new Error('offline'));
    await load.promise.catch(() => undefined);
    await Promise.resolve();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps the spinner up until the last of two quick pulls has reloaded', async () => {
    const onChange = vi.fn();
    const first = deferred();
    const second = deferred();
    const pull = createPullRefresh(onChange);
    pull.run(() => first.promise);
    pull.run(() => second.promise);
    first.resolve();
    await first.promise;
    await Promise.resolve();
    expect(onChange).toHaveBeenLastCalledWith(true);
    second.resolve();
    await second.promise;
    await Promise.resolve();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});

describe('background reloads leave the list where it is', () => {
  it.each([
    'screens/EmailListScreen.tsx',
    'screens/UnifiedInboxScreen.tsx',
  ])('%s shows the pull spinner only for a pull, not for every list load', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/refreshing=\{loading\}/);
    expect(src).toMatch(/usePullRefresh\(/);
  });
});
