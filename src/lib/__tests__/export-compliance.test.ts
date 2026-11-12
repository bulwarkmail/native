import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// PGP and S/MIME (#58) use standard algorithms and the app is not on the
// French store, so no export compliance documentation is needed: Apple's
// ITSAppUsesNonExemptEncryption is NO for that. YES needs a compliance code
// Apple only issues with a declaration it refuses for this app (upload
// validation fails, 90592), and a missing key keeps every build out of the
// external TestFlight group until someone answers by hand.

const root = path.resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);

describe('export compliance', () => {
  it('declares in Info.plist that no export compliance documentation is needed', () => {
    const config = require(path.join(root, 'app.config.js'));
    expect(config.expo.ios.config?.usesNonExemptEncryption).toBe(false);
  });

  it('gives a build uploaded without the key the same answer', () => {
    const src = fs.readFileSync(path.join(root, 'scripts/testflight-public.mjs'), 'utf8');
    expect(src).toMatch(/attributes: \{ usesNonExemptEncryption: false \}/);
    expect(src).not.toMatch(/usesNonExemptEncryption: true/);
  });
});
