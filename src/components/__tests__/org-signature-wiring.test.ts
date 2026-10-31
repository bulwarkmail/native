import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { webmailLinksFromConfig } from '../../lib/org-policy';

// The organisation's templates gate, signature and disclaimer in the
// composer and quick reply (webmail email-composer.tsx, hooks/use-org-signature.ts,
// lib/org/outgoing.ts, lib/outgoing/quick-reply.ts). No React Native
// renderer in the test env, so this checks the wiring; the pure parts have
// unit tests in lib/__tests__/org-signature.test.ts.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('organisation signature wiring', () => {
  it('hides the template picker when the organisation turns templates off', () => {
    const src = read('screens/ComposeScreen.tsx');
    expect(src).toMatch(/const templatesEnabled = usePolicyFeature\('templatesEnabled'\);/);
    expect(src).toMatch(/\{templatesEnabled && \(\s+<ToolbarButton onPress=\{\(\) => setTemplateSheetOpen\(true\)\}/);
  });

  it('signs with the organisation signature filled in for the sending identity', () => {
    const src = read('screens/ComposeScreen.tsx');
    expect(src).toMatch(/orgSignatureSetup\(orgPolicy, primaryIdentity, null, orgCompany\)/);
    expect(src).toMatch(/const signatureIdentity = React\.useMemo\(\s+\(\) => effectiveSignatureIdentity\(ownSignatureIdentity, primaryIdentity, orgSetup\.signature, orgSetup\.restriction\)/);
  });

  it('adds the locked signature and the disclaimer on send, not to drafts', () => {
    const src = read('screens/ComposeScreen.tsx');
    expect(src).toMatch(/if \(!opts\.forDraft\) \{\s+const setup = orgSignatureSetup\(usePolicyStore\.getState\(\)\.effective, identity,[^\n]*\n\s+const finished = finalizeOrgOutgoing\(\{ html: htmlBody, text: textBody \}, setup,/);
    expect(src).toMatch(/htmlBody = finished\.html;\s+textBody = finished\.text;/);
  });

  it('shows the disclaimer under the editor', () => {
    const src = read('screens/ComposeScreen.tsx');
    expect(src).toMatch(/\{!!orgDisclaimerText && \(\s+<View style=\{styles\.orgDisclaimer\} testID="org-disclaimer-preview">/);
    expect(src).toMatch(/t\('org_signature\.disclaimer_added_on_send', 'Added when you send'\)/);
  });

  it('signs a quick reply the same way', () => {
    const src = read('components/email/QuickReplyBox.tsx');
    expect(src).toMatch(/const signer = effectiveSignatureIdentity\(signatureIdentityFor\(identity, identities\), identity, orgSetup\.signature, orgSetup\.restriction\);/);
    expect(src).toMatch(/textBody: finalizeOrgOutgoing\(\{\s+text: signPlainTextReply\(body, `\$\{header\.text\}\$\{quoted\}`, signer,/);
  });

  it('reads the company name for {company} from the webmail config', () => {
    expect(webmailLinksFromConfig({ loginCompanyName: ' ACME Ltd ' }).companyName).toBe('ACME Ltd');
    expect(webmailLinksFromConfig({ loginCompanyName: '' }).companyName).toBeUndefined();
  });
});
