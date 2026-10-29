// A detail screen whose record disappears (deleted here, or removed by a
// sync) re-renders down its not-found branch. Any hook placed after that
// early return then runs one time fewer and React throws "Rendered fewer
// hooks than expected", which took the whole screen down on delete. This
// scans the screen components for hook calls after their not-found return.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCREENS = join(__dirname, '..');

/** Hook calls in `component` after the line `marker`, up to its closing brace. */
function hooksAfter(file: string, component: string, marker: string): string[] {
  const src = readFileSync(join(SCREENS, file), 'utf8');
  const start = src.indexOf(`export default function ${component}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start);
  const body = rest.slice(0, rest.search(/\r?\n\}\r?\n/));
  const at = body.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  return body.slice(at).match(/\b(?:React\.)?use[A-Z]\w*\(/g) ?? [];
}

describe('hooks run before the not-found return', () => {
  it('ContactDetailScreen', () => {
    expect(hooksAfter('ContactDetailScreen.tsx', 'ContactDetailScreen', 'if (!contact) {')).toEqual([]);
  });

  it('GroupDetailScreen', () => {
    expect(hooksAfter('GroupDetailScreen.tsx', 'GroupDetailScreen', 'if (!group) {')).toEqual([]);
  });
});
