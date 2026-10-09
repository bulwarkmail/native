import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

type Age = { installed: string; published: string | null; ageDays: number | null; latest: string | null; latestPublished: string | null };
const { pslAge, verdict, installedTldts } = createRequire(__filename)('../../../scripts/psl-age.js') as {
  pslAge: (a: { installed: string; times: Record<string, string>; now: Date }) => Age;
  verdict: (r: Age, check: boolean) => { message: string; exitCode: number };
  installedTldts: (root: string) => string | null;
};

describe('public suffix list age', () => {
  it('dates the installed list by its tldts release and names the latest stable one', () => {
    const times = { created: '2020-01-01T00:00:00Z', modified: '2026-10-08T00:00:00Z', '7.4.18': '2026-09-01T00:00:00Z', '7.5.0': '2026-10-01T00:00:00Z', '7.6.0-beta.1': '2026-10-08T00:00:00Z' };
    expect(pslAge({ installed: '7.4.18', times, now: new Date('2026-10-10T00:00:00Z') }))
      .toEqual({ installed: '7.4.18', published: '2026-09-01T00:00:00Z', ageDays: 39, latest: '7.5.0', latestPublished: '2026-10-01T00:00:00Z' });
    expect((pslAge({ installed: '0.0.1', times, now: new Date() }) as { ageDays: number | null }).ageDays).toBeNull();
  });

  const age = (over: Partial<Age>): Age => ({
    installed: '7.4.18', published: '2026-09-01T00:00:00Z', ageDays: 39, latest: '7.5.0', latestPublished: '2026-10-01T00:00:00Z', ...over,
  });

  it('fails a check only for a list older than the limit', () => {
    expect(verdict(age({}), true).exitCode).toBe(0);
    expect(verdict(age({ ageDays: 400 }), true).exitCode).toBe(1);
    expect(verdict(age({ ageDays: 400 }), false).exitCode).toBe(0);
  });

  it('says so, and exits 2 rather than as stale, when the installed release is not in the registry', () => {
    const r = verdict(age({ published: null, ageDays: null }), true);
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/7\.4\.18 is not among the registry's tldts releases/);
  });

  it('finds no tldts where none is installed', () => {
    expect(installedTldts('/nonexistent')).toBeNull();
  });
});
