import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// PGP and S/MIME (#58) are non-exempt encryption with standard algorithms, and
// the app is not on the French store, so App Store Connect has no declaration
// and no compliance code. Info.plist must not claim YES (upload validation
// rejects it without the code, 90592) nor NO (that would be untrue); the
// TestFlight script answers per build instead.

const root = path.resolve(__dirname, '../../..');

describe('export compliance', () => {
  it('leaves the encryption key out of the iOS config', () => {
    const src = fs.readFileSync(path.join(root, 'app.config.js'), 'utf8');
    expect(src).not.toMatch(/usesNonExemptEncryption\s*:/);
  });

  it('answers non-exempt encryption for each TestFlight build', () => {
    const src = fs.readFileSync(path.join(root, 'scripts/testflight-public.mjs'), 'utf8');
    expect(src).toMatch(/attributes: \{ usesNonExemptEncryption: true \}/);
  });
});
