import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The composer's options sheet (priority, DSN, REQUIRETLS) as wired in
// ComposeScreen, checked on its source (the suite has no RN renderer).
const source = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');

describe('ComposeScreen options wiring', () => {
  it('opens the options sheet from the toolbar', () => {
    expect(source).toMatch(/onPress=\{\(\) => setOptionsSheetOpen\(true\)\}/);
    expect(source).toMatch(/<ComposerOptionsSheet[\s\S]{0,200}onChange=\{onComposerOptionsChange\}/);
  });

  it('sends the priority with the message and saves it with the draft', () => {
    const build = source.slice(source.indexOf('const buildOutgoing'), source.indexOf('// Save one draft version'));
    expect(build).toMatch(/priority: priority !== 'normal' \? priority : undefined,/);
    // A priority change alone makes the message dirty.
    expect(source).toMatch(/pri: s\.priority \?\? 'normal',/);
    expect(source).toMatch(/const initialPriority: MessagePriority = draft\?\.priority \?\? 'normal';/);
  });

  it('asks for DSN and REQUIRETLS only where the submitting account offers them', () => {
    const send = source.slice(source.indexOf('const performSendInner'));
    expect(send).toMatch(/requestDsn: requestDsn && supportsSubmissionExtension\('DSN', target\.accountId\),/);
    expect(send).toMatch(/requireTls: requireTls && supportsSubmissionExtension\('REQUIRETLS', target\.accountId\),/);
  });
});
