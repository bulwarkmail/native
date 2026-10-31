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

  it('asks about a missing subject once per message', () => {
    const check = source.slice(source.indexOf('const passesEmptySubjectCheck'), source.indexOf('const confirmedPlaceholdersRef'));
    expect(check).toMatch(/if \(subject\.trim\(\) \|\| !emptySubjectWarningEnabled \|\| emptySubjectConfirmedRef\.current\) return Promise\.resolve\(true\);/);
    expect(check).toMatch(/send_anyway[\s\S]*?onPress: \(\) => \{ emptySubjectConfirmedRef\.current = true; resolve\(true\); \}/);
  });

  it('closes without "unsaved changes" when the saved draft holds every change', () => {
    const guard = source.slice(source.indexOf('usePreventRemove('));
    const end = guard.indexOf('});\n') > -1 ? guard.indexOf('});\n') : guard.indexOf('});\r\n');
    const body = guard.slice(0, end);
    expect(body.indexOf('await savedAlready()')).toBeGreaterThan(-1);
    expect(body.indexOf('await savedAlready()')).toBeLessThan(body.indexOf('showCloseDialog('));
    const saved = source.slice(source.indexOf('const savedAlready'), source.indexOf('usePreventRemove('));
    // The editor's own content, compared with the last saved snapshot.
    expect(saved).toMatch(/editorRef\.current\?\.getHtml\(\)/);
    expect(saved).toMatch(/return snapshot === lastSavedRef\.current;/);
  });

  it('offers Discard, which deletes a re-opened draft too', () => {
    const discard = source.slice(source.indexOf('const discardAndClose'), source.indexOf('const showCloseDialog'));
    expect(discard).toMatch(/if \(autosaved && !loginMoved\(\)\) \{/);
    expect(discard).not.toMatch(/!draft\b/);
    const onDiscard = source.slice(source.indexOf('const onDiscard'));
    expect(onDiscard).toMatch(/discard_draft_message/);
    expect(onDiscard).toMatch(/onPress: \(\) => discardAndClose\(/);
    expect(source).toMatch(/onPress=\{onDiscard\}/);
  });

  it('writes the text part of a rich message with mail markup', () => {
    const build = source.slice(source.indexOf('const buildOutgoing'), source.indexOf('// Save one draft version'));
    expect(build).toMatch(/textBody = htmlToPlainText\(safeHtml, \{ mailMarkup: true \}\);/);
  });
});
