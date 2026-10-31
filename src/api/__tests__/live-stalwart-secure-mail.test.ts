/**
 * Live checks of PGP and S/MIME mail (#58) against a real Stalwart: a
 * signed and encrypted message is built the way the composer builds it,
 * uploaded and sent with Email/import + EmailSubmission from the first
 * login to the second, fetched there as the raw message and decrypted with
 * the recipient's key, signature checked. The sender's Sent copy opens with
 * the sender's key (encrypt-to-self).
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP`,
 * `BULWARK_LIVE_PASS` and `BULWARK_LIVE_USER2` are set (`BULWARK_LIVE_PASS2`
 * defaults to the first password). The keys are made fresh for the run.
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-perf@example.org BULWARK_LIVE_PASS=… \
 *   BULWARK_LIVE_USER2=e2e-tablet-land@example.org \
 *   npx vitest run src/api/__tests__/live-stalwart-secure-mail.test.ts
 *
 * Every message the run sends is removed from both accounts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { JMAPClient } from '../jmap-client';
import { destroyEmails, getMailboxes, sendEmail } from '../email';
import { getIdentities } from '../identity';
import { uploadBytes } from '../blob';
import { fetchBlobBytes } from '../../lib/email-export';
import { buildSecureMessage } from '../../lib/crypto/secure-send';
import { openSecureMessage, type SecureKeyAccess } from '../../lib/crypto/secure-message';
import type { MimeMessageInput } from '../../lib/crypto/mime';
import { makePgpKey, makeSmimeCert, useNodeCrypto } from '../../lib/crypto/__tests__/helpers';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'e2e-perf@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const USER2 = process.env.BULWARK_LIVE_USER2;
const PASS2 = process.env.BULWARK_LIVE_PASS2 ?? PASS;
const live = SERVER && PASS && USER2 ? describe : describe.skip;

const RUN_STARTED = Date.now();
const TAG = `bulwark-secure-${RUN_STARTED.toString(36)}`;

let jmap: JMAPClient;
let sender: JMAPClient;
let recipient: JMAPClient;

const as = (client: JMAPClient) => jmap.restoreSnapshot(client.snapshot());

/** The raw bytes of the message with this subject in the recipient's account (waits for delivery). */
async function receive(subject: string): Promise<Uint8Array> {
  as(recipient);
  for (let i = 0; i < 40; i++) {
    const res = await jmap.request([
      ['Email/query', { accountId: jmap.accountId, filter: { after: new Date(RUN_STARTED - 60_000).toISOString() }, limit: 100 }, '0'],
      ['Email/get', { accountId: jmap.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject', 'blobId'] }, '1'],
    ]);
    const hit = (res.methodResponses[1][1].list as Array<{ subject?: string; blobId: string }>).find((e) => e.subject === subject);
    if (hit) return fetchBlobBytes(hit.blobId, 'message.eml', 'message/rfc822');
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`"${subject}" did not arrive`);
}

async function removeRunMail(client: JMAPClient): Promise<void> {
  as(client);
  const res = await jmap.request([
    ['Email/query', { accountId: jmap.accountId, filter: { after: new Date(RUN_STARTED - 60_000).toISOString() }, limit: 500 }, '0'],
    ['Email/get', { accountId: jmap.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject'] }, '1'],
  ]);
  const ids = (res.methodResponses[1][1].list as Array<{ id: string; subject?: string }>).filter((e) => e.subject?.includes(TAG)).map((e) => e.id);
  if (ids.length) await destroyEmails(ids);
}

/** Send `raw` from the sender like the composer: upload, Email/import into Drafts, submit, file in Sent. */
async function sendRaw(raw: Uint8Array, to: string): Promise<string> {
  as(sender);
  const [identity] = await getIdentities();
  const boxes = await getMailboxes();
  const drafts = boxes.find((b) => b.role === 'drafts')!.id;
  const sent = boxes.find((b) => b.role === 'sent')!.id;
  const { blobId } = await uploadBytes(raw, 'message/rfc822');
  const result = await sendEmail(
    { from: [{ email: identity.email }], to: [{ email: to }], subject: 'not used for a raw send' },
    identity.id, sent, undefined, { draftsMailboxId: drafts, rawBlobId: blobId },
  );
  expect(result.emailSubmissionId).toBeTruthy();
  return result.emailId!;
}

async function sentCopy(emailId: string): Promise<Uint8Array> {
  as(sender);
  const res = await jmap.request([['Email/get', { accountId: jmap.accountId, ids: [emailId], properties: ['blobId', 'mailboxIds', 'keywords'] }, '0']]);
  const [email] = res.methodResponses[0][1].list;
  return fetchBlobBytes(email.blobId, 'message.eml', 'message/rfc822');
}

const message = (from: string, to: string, subject: string): MimeMessageInput => ({
  from: { name: 'Bulwark Live', email: from },
  to: [{ email: to }],
  subject,
  textBody: 'Geheime Grüße aus dem Live-Test',
  htmlBody: '<p>Geheime <b>Grüße</b> aus dem Live-Test</p>',
  attachments: [{ filename: 'live.txt', contentType: 'text/plain', content: new TextEncoder().encode('attachment') }],
});

live('live Stalwart: PGP and S/MIME mail', () => {
  beforeAll(async () => {
    useNodeCrypto();
    const mod = await import('../jmap-client');
    jmap = mod.jmapClient as unknown as JMAPClient;
    sender = new JMAPClient();
    await sender.connect(SERVER!, USER, PASS);
    recipient = new JMAPClient();
    await recipient.connect(SERVER!, USER2!, PASS2);
  }, 60_000);

  afterAll(async () => {
    await removeRunMail(sender).catch(() => undefined);
    await removeRunMail(recipient).catch(() => undefined);
  }, 60_000);

  it('sends a signed and encrypted PGP/MIME message that the recipient decrypts and verifies', async () => {
    as(sender);
    const [identity] = await getIdentities();
    const me = await makePgpKey(identity.email);
    const them = await makePgpKey(USER2!);
    const subject = `pgp ${TAG}`;
    const raw = await buildSecureMessage(message(identity.email, USER2!, subject), { mode: 'pgp', sign: true, encrypt: true }, {
      pgp: { signingKey: me.unlocked, encryptionKeys: [them.publicKey, me.publicKey] },
    });
    const emailId = await sendRaw(raw, USER2!);

    const received = await receive(subject);
    expect(new TextDecoder().decode(received)).not.toContain('Geheime');
    const access: SecureKeyAccess = {
      pgpDecryptionKeys: () => [them.unlocked],
      pgpOwnKeys: () => [{ id: 'them', publicKeyArmored: them.publicKey, unlocked: true }],
      pgpPublicKeys: () => [me.publicKey],
      smimeKeys: () => [],
    };
    const res = await openSecureMessage(received, identity.email, access);
    expect(res?.status).toMatchObject({ kind: 'pgp', encrypted: true, decrypted: true, signature: 'valid', signerEmail: identity.email.toLowerCase() });
    expect(res?.body?.html).toContain('<b>Grüße</b>');
    expect(res?.attachments.map((a) => a.name)).toEqual(['live.txt']);

    // The Sent copy opens with the sender's own key.
    const own = await openSecureMessage(await sentCopy(emailId), identity.email, {
      ...access, pgpDecryptionKeys: () => [me.unlocked], pgpOwnKeys: () => [{ id: 'me', publicKeyArmored: me.publicKey, unlocked: true }],
    });
    expect(own?.status.decrypted).toBe(true);
  }, 120_000);

  it('sends a signed and encrypted S/MIME message that the recipient decrypts and verifies', async () => {
    as(sender);
    const [identity] = await getIdentities();
    const me = await makeSmimeCert(identity.email);
    const them = await makeSmimeCert(USER2!);
    const subject = `smime ${TAG}`;
    const raw = await buildSecureMessage(message(identity.email, USER2!, subject), { mode: 'smime', sign: true, encrypt: true }, {
      smime: {
        signer: { pkcs8: me.pkcs8, certificate: me.certificate, chain: [], algorithm: 'RSA-2048' },
        recipientCerts: [them.certificate],
        senderCert: me.certificate,
      },
    });
    const emailId = await sendRaw(raw, USER2!);

    const received = await receive(subject);
    const access = (cert: typeof me): SecureKeyAccess => ({
      pgpDecryptionKeys: () => [], pgpOwnKeys: () => [], pgpPublicKeys: () => [],
      smimeKeys: () => [{ id: cert.email, certificate: cert.certificate, pkcs8: cert.pkcs8 }],
    });
    const res = await openSecureMessage(received, identity.email, access(them));
    expect(res?.status).toMatchObject({ kind: 'smime', encrypted: true, decrypted: true, signature: 'valid', signerEmail: identity.email.toLowerCase() });
    expect(res?.body?.text).toContain('Grüße');
    expect(res?.attachments.map((a) => a.name)).toEqual(['live.txt']);

    const own = await openSecureMessage(await sentCopy(emailId), identity.email, access(me));
    expect(own?.status.decrypted).toBe(true);
  }, 120_000);

  it('sends a detached S/MIME signature the recipient verifies', async () => {
    as(sender);
    const [identity] = await getIdentities();
    const me = await makeSmimeCert(identity.email);
    const subject = `smime-signed ${TAG}`;
    const raw = await buildSecureMessage(message(identity.email, USER2!, subject), { mode: 'smime', sign: true, encrypt: false }, {
      smime: { signer: { pkcs8: me.pkcs8, certificate: me.certificate, chain: [], algorithm: 'RSA-2048' } },
    });
    await sendRaw(raw, USER2!);
    const res = await openSecureMessage(await receive(subject), identity.email, { pgpDecryptionKeys: () => [], pgpOwnKeys: () => [], pgpPublicKeys: () => [], smimeKeys: () => [] });
    expect(res?.status).toMatchObject({ kind: 'smime', encrypted: false, signature: 'valid' });
  }, 120_000);
});
