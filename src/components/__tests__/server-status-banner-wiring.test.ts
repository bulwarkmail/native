import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// No React Native renderer in the test env: this checks how the server
// status banner (#167) is wired. Its store and the client's reports have
// unit tests (stores/__tests__/server-status-store.test.ts and the last
// block of api/__tests__/jmap-client-hardening.test.ts).

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('server status banner wiring', () => {
  it('sits on the mail list under the offline banner, its Retry reloading folders when none is selected', () => {
    const src = read('screens/EmailListScreen.tsx');
    expect(src).toMatch(/<OfflineBanner [^\n]*\/>\s+<ServerStatusBanner\s+onRetry=/);
    expect(src).toMatch(/<ServerStatusBanner[\s\S]*?if \(mailboxes\.length === 0 \|\| !currentMailboxId\) void fetchMailboxes\(\);\s+else void refreshEmails\(\);/);
  });

  it('Retry drops the refresh wait and brings the session up when there is none', () => {
    const src = read('components/ServerStatusBanner.tsx');
    expect(src).toMatch(/clearRefreshBackoff\(\);[\s\S]*?if \(jmapClient\.isConnected\) onRetry\(\);\s+else void retrySession\(\);/);
  });

  it('offers Sign in again only for a sign-in that cannot be renewed, keeping the account', () => {
    const src = read('components/ServerStatusBanner.tsx');
    expect(src).toMatch(/problem === 'sign_in_failing' && \([\s\S]*?signInAgain\(activeAccountId\)/);
    expect(src).not.toMatch(/requestReauth/);
  });
});
