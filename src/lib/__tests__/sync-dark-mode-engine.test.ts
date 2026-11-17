import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EMAIL_DARK_MODE_LIB } from '../email-dark-mode';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'sync-dark-mode-engine.mjs');
const VENDORED = path.join(ROOT, 'src', 'lib', 'email-dark-mode.ts');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function checkout(engine: string | null) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-engine-'));
  dirs.push(top);
  const app = path.join(top, 'apps', 'native');
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(app, 'src', 'lib'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(app, 'scripts', 'sync-dark-mode-engine.mjs'));
  fs.copyFileSync(VENDORED, path.join(app, 'src', 'lib', 'email-dark-mode.ts'));
  if (engine !== null) {
    fs.mkdirSync(path.join(top, 'lib'));
    fs.writeFileSync(path.join(top, 'lib', 'email-dark-mode-engine.js'), engine);
  }
  const target = path.join(app, 'src', 'lib', 'email-dark-mode.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(app, 'scripts', 'sync-dark-mode-engine.mjs'), ...args], { encoding: 'utf8' });
  return { target, run };
}

const engineFile = (source: string) => `export default ${source};\n`;

describe('scripts/sync-dark-mode-engine.mjs', () => {
  it('finds the vendored engine up to date against the same webmail file', () => {
    const { run } = checkout(engineFile(EMAIL_DARK_MODE_LIB));
    const res = run('--check');
    expect(res.stdout).toContain('up to date');
    expect(res.status).toBe(0);
  });

  it('fails the check when the webmail engine changed, and leaves the app file alone', () => {
    const { target, run } = checkout(engineFile(EMAIL_DARK_MODE_LIB.replace("'use strict';", "'use strict';\n  var changed = 1;")));
    const before = fs.readFileSync(target, 'utf8');
    expect(run('--check').status).toBe(1);
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });

  it('writes the changed engine into the app file, which then evaluates to it', () => {
    const changed = EMAIL_DARK_MODE_LIB.replace("'use strict';", "'use strict';\n  var changed = 1;");
    const { target, run } = checkout(engineFile(changed));
    expect(run().status).toBe(0);
    expect(fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')).toContain('export const EMAIL_DARK_MODE_LIB = String.raw`' + changed + '`;');
    expect(run('--check').status).toBe(0);
  });

  it('reads an engine and an app file with other line endings as the same, and keeps the app file\'s', () => {
    const lf = fs.readFileSync(VENDORED, 'utf8').replace(/\r\n/g, '\n');
    const same = checkout(engineFile(EMAIL_DARK_MODE_LIB).replace(/\n/g, '\r\n'));
    fs.writeFileSync(same.target, lf);
    expect(same.run('--check').stdout).toContain('up to date');

    const changed = EMAIL_DARK_MODE_LIB.replace("'use strict';", "'use strict';\n  var changed = 1;");
    const crlf = checkout(engineFile(changed));
    fs.writeFileSync(crlf.target, lf.replace(/\n/g, '\r\n'));
    expect(crlf.run().status).toBe(0);
    const written = fs.readFileSync(crlf.target, 'utf8');
    expect(written).toContain('var changed = 1;');
    expect(written).not.toMatch(/[^\r]\n/);
  });

  it('fails the check when there is no webmail engine to compare with', () => {
    const { run } = checkout(null);
    const res = run('--check');
    expect(res.status).toBe(2);
    expect(res.stdout).not.toContain('up to date');
  });

  it('asks for the path when --webmail has none', () => {
    const { target, run } = checkout(engineFile(EMAIL_DARK_MODE_LIB));
    const before = fs.readFileSync(target, 'utf8');
    for (const args of [['--webmail'], ['--webmail', '--check'], ['--check', '--webmail']]) {
      const res = run(...args);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('--webmail <path>');
    }
    expect(fs.readFileSync(target, 'utf8')).toBe(before);
  });

  it('refuses an engine that cannot sit in a raw string', () => {
    for (const bad of ['var s = `x`;', 'var s = "${x}";']) {
      const { target, run } = checkout(engineFile(EMAIL_DARK_MODE_LIB.replace("'use strict';", "'use strict';\n  " + bad)));
      const before = fs.readFileSync(target, 'utf8');
      expect(run().status).toBe(2);
      expect(fs.readFileSync(target, 'utf8')).toBe(before);
    }
  });
});
