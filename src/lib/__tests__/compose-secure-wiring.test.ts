import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Sign / encrypt in the composer (#58) as wired in ComposeScreen, checked on
// its source (the suite has no RN renderer): the options sheet gets the
// availability, a secure send goes out as the uploaded raw message, and it
// never lands in the Outbox, which would send it as plain mail later.
const source = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
const reader = fs.readFileSync(path.resolve(__dirname, '../../components/email/MessageContent.tsx'), 'utf8');

describe('ComposeScreen sign / encrypt wiring', () => {
  it('passes the keys the From address has to the options sheet', () => {
    expect(source).toMatch(/<ComposerOptionsSheet[\s\S]{0,400}secureAvailable=\{secureAvailable\}/);
  });

  it('sends the signed / encrypted blob through sendEmail', () => {
    expect(source).toMatch(/const blobId = await prepareSecureBlob\(secureChoice, outgoing, target\.accountId\);/);
    expect(source).toMatch(/requireTls: requireTls && supportsSubmissionExtension\('REQUIRETLS', target\.accountId\),\s*rawBlobId,/);
  });

  it('keeps a secure send out of the Outbox', () => {
    const block = source.slice(source.indexOf('if (secureChoice) {'), source.indexOf('const target = await sendTargetFor(primaryIdentity'));
    expect(block).toMatch(/if \(!useNetworkStore\.getState\(\)\.online\) \{[\s\S]*?return;/);
    expect(block).toMatch(/\} else \{\s*queuedOutgoing = outgoing;/);
  });
});

describe('reader wiring', () => {
  it('shows the decrypted body and the banner', () => {
    expect(reader).toMatch(/const secure = useSecureMessage\(email, jmapAccountId\);/);
    expect(reader).toMatch(/bodyOverride=\{bodyOverride\}/);
    expect(reader).toMatch(/<SecureMessageBanner status=/);
    // A signed message's attachments are already listed by the server.
    expect(reader).toMatch(/secure\.result\?\.status\.encrypted && secure\.result\.attachments\.length/);
  });
});
