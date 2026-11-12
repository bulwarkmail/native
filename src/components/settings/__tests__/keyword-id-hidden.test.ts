import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Tag settings printed the stored keyword ($label:work) under every tag, in
// the shared tags and under the name field; the webmail hides it (3609b5c99).

describe('tag settings', () => {
  it("don't show the stored $label: keyword of a tag", () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../KeywordSettings.tsx'), 'utf8');
    expect(src).not.toMatch(/\$label:\{/);
  });
});
