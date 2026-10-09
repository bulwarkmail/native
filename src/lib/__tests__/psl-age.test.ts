import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { pslAge } = createRequire(__filename)('../../../scripts/psl-age.js') as {
  pslAge: (a: { installed: string; times: Record<string, string>; now: Date }) => unknown;
};

describe('public suffix list age', () => {
  it('dates the installed list by its tldts release and names the latest stable one', () => {
    const times = { created: '2020-01-01T00:00:00Z', modified: '2026-10-08T00:00:00Z', '7.4.18': '2026-09-01T00:00:00Z', '7.5.0': '2026-10-01T00:00:00Z', '7.6.0-beta.1': '2026-10-08T00:00:00Z' };
    expect(pslAge({ installed: '7.4.18', times, now: new Date('2026-10-10T00:00:00Z') }))
      .toEqual({ installed: '7.4.18', published: '2026-09-01T00:00:00Z', ageDays: 39, latest: '7.5.0', latestPublished: '2026-10-01T00:00:00Z' });
    expect((pslAge({ installed: '0.0.1', times, now: new Date() }) as { ageDays: number | null }).ageDays).toBeNull();
  });
});
