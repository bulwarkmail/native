import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { webmailLinksFromConfig, helpLinks } from '../../lib/org-policy';

// The organisation's customFromEnabled gate (webmail composing-settings.tsx,
// email-composer.tsx) and the webmail's "no third-party traffic" mode (#903,
// hooks/use-third-party-mode.ts, reading-settings.tsx, email-viewer.tsx). No
// React Native renderer in the test env, so this checks the wiring.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('customFromEnabled', () => {
  it('shows Received Address Matching only when custom From is allowed', () => {
    const src = read('components/settings/ComposingSettings.tsx');
    expect(src).toMatch(/const customFromEnabled = usePolicyFeature\('customFromEnabled'\);/);
    expect(src).toMatch(/\{autoSelectReplyIdentity && customFromEnabled && \(/);
  });

  it('matches only exact identities in the composer when custom From is off', () => {
    expect(read('screens/ComposeScreen.tsx')).toMatch(/matchMode: customFromEnabled \? replyIdentityMatch : 'exact',/);
  });
});

describe('no third-party traffic', () => {
  it('reads the mode from the webmail config, as a boolean or an env-style string', () => {
    expect(webmailLinksFromConfig({ noThirdPartyTraffic: true }).noThirdPartyTraffic).toBe(true);
    expect(webmailLinksFromConfig({ noThirdPartyTraffic: 'Yes' }).noThirdPartyTraffic).toBe(true);
    expect(webmailLinksFromConfig({ noThirdPartyTraffic: false }).noThirdPartyTraffic).toBeUndefined();
    expect(webmailLinksFromConfig({ noThirdPartyTraffic: 'no' }).noThirdPartyTraffic).toBeUndefined();
    // Not a help link.
    expect(helpLinks(webmailLinksFromConfig({ noThirdPartyTraffic: true }))).toEqual([]);
  });

  it('shows External Content as the organisation\'s, set to block', () => {
    const src = read('components/settings/ContentSendersSettings.tsx');
    expect(src).toMatch(/const remoteBlockedByOrg = useNoThirdPartyTraffic\(\);/);
    expect(src).toMatch(/locked=\{externalContentLocked \|\| remoteBlockedByOrg\}/);
    expect(src).toMatch(/value=\{remoteBlockedByOrg \? 'block' : externalContentPolicy\}/);
  });

  it('never loads remote content in the reader and offers nothing to load it', () => {
    const src = read('components/EmailBodyView.tsx');
    expect(src).toMatch(/!!rawHtml && \(\s+remoteBlockedByOrg \|\|\s+\(!trusted && !allowOnce && externalContentPolicy !== 'allow'\)\s+\)/);
    expect(src).toMatch(/\{!remoteBlockedByOrg && <View style=\{styles\.bannerActions\}>/);
    expect(src).toMatch(/t\('third_party\.remote_content_blocked'/);
  });

  it('keeps remote images blocked in booking cards and quoted originals', () => {
    expect(read('components/email/structured-mail/StructuredMailBanner.tsx')).toMatch(/\(\) => !remoteBlockedByOrg && \(policy === 'allow' \|\|/);
    const compose = read('screens/ComposeScreen.tsx');
    expect(compose).toMatch(/externalContentPolicy: remoteBlockedByOrg \? 'block' : settings\.externalContentPolicy,/);
    expect(compose).toMatch(/senderTrusted: !remoteBlockedByOrg && !!sender/);
  });
});
