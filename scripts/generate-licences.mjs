// Writes src/lib/licences.json: the libraries the app ships (the runtime
// dependencies in package.json) with their licence, for Settings → About →
// Open-source licences. Run after adding or upgrading a dependency:
//
//   node scripts/generate-licences.mjs
//
// The test in src/lib/__tests__/licences.test.ts fails when a dependency is
// missing from the list.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// Code that isn't an npm dependency but ships in the app.
const VENDORED = [
  { name: 'Tabler Icons', version: '', license: 'MIT', url: 'https://tabler.io/icons' },
];

function repoUrl(meta) {
  const repo = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url;
  const url = meta.homepage || repo || '';
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/#.*$/, '');
}

const libraries = Object.keys(pkg.dependencies).sort().map((name) => {
  const file = join(ROOT, 'node_modules', name, 'package.json');
  if (!existsSync(file)) throw new Error(`${name} is not installed`);
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  const license = typeof meta.license === 'string' ? meta.license : meta.license?.type ?? 'See package';
  return { name, version: meta.version, license, url: repoUrl(meta) };
});

const out = {
  app: { name: pkg.name, license: pkg.license },
  libraries: [...libraries, ...VENDORED],
};
writeFileSync(join(ROOT, 'src', 'lib', 'licences.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`${out.libraries.length} libraries`);
