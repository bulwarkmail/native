import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(__dirname, '../../..');
const PLUGIN = path.join(ROOT, 'plugins/ios-push');
const hasSwift = process.platform === 'darwin' && spawnSync('swiftc', ['--version']).status === 0;
const plugin = createRequire(__filename)(path.join(PLUGIN, 'index.js')) as {
  internals: { SOURCE_FILES: string[]; APP_SOURCE_FILES: string[] };
};

describe('the iOS notification extension on a push without message ids', () => {
  it('builds the new-mail lookup into the extension', () => {
    expect(plugin.internals.SOURCE_FILES).toContain('NewMail.swift');
  });

  it.skipIf(!hasSwift)('shows the mail that just came and never the same message twice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulwark-newmail-'));
    try {
      const binary = path.join(dir, 'tests');
      const sources = ['SharedKeychain.swift', 'Jmap.swift', 'PushRenewal.swift', 'NewMail.swift'].map((file) => path.join(PLUGIN, file));
      const main = path.join(dir, 'main.swift');
      fs.copyFileSync(path.join(PLUGIN, 'tests/NewMailTests.swift'), main);
      execFileSync('swiftc', ['-o', binary, ...sources, main], { stdio: 'pipe' });
      const run = spawnSync(binary, { encoding: 'utf8' });
      expect(run.stdout).toContain('all passed');
      expect(run.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
