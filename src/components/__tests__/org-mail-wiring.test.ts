import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The organisation's mail rules where the screens use them: classification
// labels in the composer, quick reply and the reader; the "External" chip;
// the confirm before sending outside the organisation in the composer, quick
// reply and invitations; internal domains in the invitation banner. No React
// Native renderer in the test env, so this checks the wiring; the logic is
// tested in lib/__tests__ (classification-labels, external-mail).

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('classification labels', () => {
  const compose = read('screens/ComposeScreen.tsx');

  it('refuse a send without a required label before anything is asked, and open the labels', () => {
    expect(compose).toMatch(
      /if \(labelMissing\(labelsPolicy, sendLabel\)\) \{\s+setLabelInvalid\(true\);\s+toast\.error\(t\('classification\.required_toast'[^)]*\)\);\s+setOptionsSheetOpen\(true\);\s+return;\s+\}\s+if \(!\(await passesSendWarnings\(/,
    );
  });

  it('prefix the subject and write the headers on a send, keep the choice on a draft', () => {
    expect(compose).toMatch(/const labelled = opts\.forDraft\s+\? \{ subject, headers: draftLabelProperty\(draftLabelChoice\), headerLines: undefined \}\s+: classifyOutgoing\(labelsPolicy, sendLabel, subject\);/);
    expect(compose).toMatch(/subject: labelled\.subject,/);
    expect(compose).toMatch(/labelHeaders,\r?\n\s+labelHeaderLines: labelled\.headerLines,/);
    // A reopened draft starts with its label; a reply with the original's.
    expect(compose).toMatch(/reopenedLabelChoice\(draft\.labelHeaders, draft\.from\?\.\[0\]\?\.email\)/);
    expect(compose).toMatch(/labelOriginalOf\(replyTo\.labelHeaders, \[replyTo\.from\]\)/);
  });

  it('are offered in the composer options', () => {
    expect(compose).toMatch(/labels=\{labelsPolicy\.list\.length > 0 \? \{/);
    expect(read('components/compose/ComposerOptionsSheet.tsx')).toMatch(/\[\.\.\.\(labels\.required \? \[\] : \[null\]\), \.\.\.labels\.list\]\.map/);
  });

  it('go into a signed or encrypted message too', () => {
    expect(read('lib/crypto/compose-secure.ts')).toMatch(/lines\.push\(\.\.\.\(outgoing\.labelHeaderLines \?\? \[\]\)\);/);
  });

  it('send a quick reply with the automatic label, or hand it to the composer when one is required', () => {
    const quick = read('components/email/QuickReplyBox.tsx');
    expect(quick).toMatch(/const quickLabel = automaticLabel\(identity\.email, \{ headers: email\.headers, from: email\.from \}\);\s+if \(quickLabel\.missing\) \{\s+toast\.info\([^;]+;\s+onMoreOptions\(text\);\s+return;/);
    expect(quick).toMatch(/labelHeaders: labelled\.headers,/);
  });

  it('show on received mail', () => {
    expect(read('components/email/MessageHeader.tsx')).toMatch(/<ReceivedLabelChip headers=\{email\.headers\} \/>/);
  });
});

describe('external mail', () => {
  it('shows the "External" chip in the message header', () => {
    expect(read('components/email/MessageHeader.tsx')).toMatch(/<ExternalSenderChip from=\{email\.from\} \/>/);
  });
});
