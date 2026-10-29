import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A group or shared identity sends from the group's account with that
// account's identity id (lib/compose-send-account). Both places below used
// the login's own identity id, which names nothing in the group account:
// "Send now" from the undo bar lost the message, and a quick reply was
// refused or went out through another identity.
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('send target wiring', () => {
  it("records the target's identity for the undo bar of a composer send", () => {
    const source = read('../../screens/ComposeScreen.tsx');
    const held = source.slice(source.indexOf('recordHeldSend(result, holdForSeconds'));
    expect(held).toMatch(/^recordHeldSend\(result, holdForSeconds, \{[\s\S]*?identityId: target\.identityId,/);
    expect(held.slice(0, 300)).not.toContain('primaryIdentity.id');
  });

  it('sends a quick reply through the target the composer would pick', () => {
    const source = read('../../components/email/QuickReplyBox.tsx');
    expect(source).toMatch(/const target = await sendTargetFor\(identity, identity\.email, mailboxes\)/);
    const call = source.slice(source.indexOf('await sendEmail('));
    expect(call).toMatch(/\},\s+target\.identityId,\s+target\.sentMailboxId,/);
    expect(call).toMatch(/accountId: target\.accountId \}/);
    expect(source).toMatch(/recordHeldSend\(result, holdFor, \{\s*identityId: target\.identityId,/);
    expect(source).not.toMatch(/identity\.id,\s+sent\./);
  });
});
