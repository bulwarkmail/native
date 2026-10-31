import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Checked on the source: the suite has no React Native renderer.
const source = fs.readFileSync(path.resolve(__dirname, '../ParticipantInput.tsx'), 'utf8');

describe('ParticipantInput wiring', () => {
  it('offers no system autofill in the participant address field, as the composer\u2019s fields do', () => {
    const input = source.slice(source.indexOf('<TextInput'), source.indexOf('/>', source.indexOf('<TextInput')));
    expect(input).toMatch(/autoComplete="off"/);
    expect(input).toMatch(/importantForAutofill="no"/);
    expect(input).toMatch(/textContentType="none"/);
  });
});
