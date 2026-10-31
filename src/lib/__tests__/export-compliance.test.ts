import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// With PGP and S/MIME in the app (#58) the encryption is no longer only
// HTTPS/TLS, so the App Store export compliance answer must say so.

describe('export compliance', () => {
  it('declares non-exempt encryption for iOS', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../app.config.js'), 'utf8');
    expect(src).toMatch(/usesNonExemptEncryption: true/);
    expect(src).not.toMatch(/usesNonExemptEncryption: false/);
  });
});
