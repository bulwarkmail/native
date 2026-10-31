import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Composer behaviour that lives in ComposeScreen itself, checked on its
// source (the suite has no React Native renderer).
const source = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');

describe('ComposeScreen wiring', () => {
  it('lets a From picked by hand bring its own (possibly empty) signature', () => {
    expect(source).toMatch(/signatureIdentityFor\(primaryIdentity, identities, \{ pickedByUser: identityPickedByUser \}\)/);
    const sheet = source.slice(source.indexOf('<IdentitySheet'));
    expect(sheet.slice(0, 400)).toMatch(/onPick=\{\(identity\) => \{[^}]*setIdentityPickedByUser\(true\)/);
  });
});
