import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// An expired session (or no connection) used to leave the composer's draft
// only in memory: Save Draft failed, and the text was lost with the app. The
// composer now keeps it on the device (lib/compose-rescue). No React Native
// renderer in the test env, so this checks the wiring.

const src = fs.readFileSync(path.resolve(__dirname, '..', 'ComposeScreen.tsx'), 'utf8');

describe('composer draft kept on the device', () => {
  it('keeps a draft the server could not take because of the session or the connection', () => {
    expect(src).toMatch(/\(isAuthError\(err\) \|\| isTransientNetworkError\(err\)\)\) \{\s+keptOnDeviceRef\.current = true;\s+await rescueDraft\(ownerLoginRef\.current, \{/);
    expect(src).toMatch(/throw new DraftKeptOnDeviceError\(err\);/);
  });

  it('closes on Save Draft once the draft is kept, and says where it goes', () => {
    expect(src).toMatch(/if \(err instanceof DraftKeptOnDeviceError\) \{\s+\/\/[^\n]*\n\s+closedWithKeptDraftRef\.current = true;\s+allowLeaveRef\.current = true;/);
    expect(src).toMatch(/t\('email_composer\.draft_kept_title'/);
  });

  it('drops the kept copy once the server has the draft, or the message is sent or discarded', () => {
    expect(src).toMatch(/keptOnDeviceRef\.current = false;\s+void forgetRescuedDraft\(ownerLoginRef\.current, composeIdRef\.current\);/);
    expect(src).toMatch(/if \(allowLeaveRef\.current && !closedWithKeptDraftRef\.current\) void forgetRescuedDraft\(login, id\);/);
  });

  it('saves a kept draft of an open composer once the session is back', () => {
    expect(src).toMatch(/if \(!sessionUp \|\| !online \|\| !keptOnDeviceRef\.current \|\| sendingRef\.current\) return;/);
  });
});
