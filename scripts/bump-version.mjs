#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionFile = path.join(root, 'VERSION');
const pkgFile = path.join(root, 'package.json');
const lockFile = path.join(root, 'package-lock.json');

const git = (...args) =>
  execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
const gitInherit = (...args) =>
  execFileSync('git', args, { cwd: root, stdio: 'inherit' });

const dirty = git('status', '--porcelain');
if (dirty) {
  console.error('Working tree is not clean. Commit or stash changes before bumping.');
  console.error(dirty);
  process.exit(1);
}

const current = fs.readFileSync(versionFile, 'utf8').trim();
const parts = current.split('.').map(Number);
if (parts.length !== 3 || parts.some(Number.isNaN)) {
  console.error(`Invalid version in VERSION: "${current}" (expected MAJOR.MINOR.PATCH)`);
  process.exit(1);
}
parts[2] += 1;
const next = parts.join('.');

const existingTags = new Set(git('tag', '--list').split(/\r?\n/).filter(Boolean));
if (existingTags.has(next)) {
  console.error(`Tag ${next} already exists.`);
  process.exit(1);
}

fs.writeFileSync(versionFile, `${next}\n`);

const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
pkg.version = next;
fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);

const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
lock.version = next;
if (lock.packages?.['']) lock.packages[''].version = next;
fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);

console.log(`${current} -> ${next}`);

gitInherit('add', 'VERSION', 'package.json', 'package-lock.json');
gitInherit('commit', '-m', `chore: update version number to ${next}`);
gitInherit('tag', '-a', next, '-m', next);
gitInherit('push', '--follow-tags');

execFileSync(
  'gh',
  ['release', 'create', next, '--title', next, '--generate-notes'],
  { cwd: root, stdio: 'inherit' },
);

console.log(`Released ${next}`);
