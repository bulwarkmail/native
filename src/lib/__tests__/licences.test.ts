import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import licences from '../licences.json';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));

describe('open-source licences', () => {
  it('lists every library the app ships, with its licence', () => {
    const listed = new Map(licences.libraries.map((l) => [l.name, l]));
    const missing = Object.keys(pkg.dependencies).filter((name) => !listed.has(name));
    // Regenerate with `node scripts/generate-licences.mjs`.
    expect(missing).toEqual([]);
    for (const name of Object.keys(pkg.dependencies)) {
      expect(listed.get(name)?.license, name).toBeTruthy();
      expect(listed.get(name)?.version, name).toBe(
        JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'node_modules', name, 'package.json'), 'utf8')).version,
      );
    }
  });

  it('names the app licence from package.json', () => {
    expect(licences.app.license).toBe(pkg.license);
  });
});
