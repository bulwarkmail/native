// Building signed and/or encrypted outgoing mail (#58). Port of the
// plugins' onComposeSend: repos/plugins/bulwark-gpg/src/index.js (PGP/MIME,
// RFC 3156) and repos/plugins/smime/src/index.js (detached or opaque
// signing, sign-then-encrypt). The result is a complete RFC 5322 message;
// the caller uploads it and sends it with Email/import + EmailSubmission
// (src/api/email.ts sendEmail with a raw blob, the plugins' host.jmap.sendRaw).

import type * as OpenPgp from 'openpgp';
import {
  buildMimeEntity, buildMimeMessage, cmsInnerEntity, wrapCmsMessage, wrapPgpEncrypted, wrapPgpSigned, wrapSmimeDetached,
  type MimeMessageInput,
} from './mime';
import { detachedSign, encryptBytes } from './pgp';
import type { SmimeSigner } from './smime/cms';

export type SecureMode = 'pgp' | 'smime';

export interface SecureSendOptions {
  mode: SecureMode;
  sign: boolean;
  encrypt: boolean;
}

export interface PgpSendKeys {
  /** Unlocked; required to sign. */
  signingKey?: OpenPgp.PrivateKey | null;
  /** Armored public keys of every recipient plus the sender (encrypt-to-self). */
  encryptionKeys?: string[];
}

export interface SmimeSendKeys {
  signer?: SmimeSigner;
  /** DER certificates of every recipient. */
  recipientCerts?: Uint8Array[];
  /** The sender's certificate, so Sent stays readable. */
  senderCert?: Uint8Array;
}

/** Build the raw message for a signed and/or encrypted send. */
export async function buildSecureMessage(
  input: MimeMessageInput,
  opts: SecureSendOptions,
  keys: { pgp?: PgpSendKeys; smime?: SmimeSendKeys },
): Promise<Uint8Array> {
  if (!opts.sign && !opts.encrypt) throw new Error('Nothing to sign or encrypt');

  if (opts.mode === 'pgp') {
    const k = keys.pgp ?? {};
    if (opts.sign && !k.signingKey) throw new Error('No unlocked PGP key to sign with');
    const entity = buildMimeEntity(input);
    if (opts.encrypt) {
      if (!k.encryptionKeys?.length) throw new Error('No recipient public keys available to encrypt to');
      const armored = await encryptBytes({ data: entity, recipientPublicKeysArmored: [...new Set(k.encryptionKeys)], signingKey: opts.sign ? k.signingKey : null });
      return wrapPgpEncrypted(armored, input);
    }
    const signature = await detachedSign(entity, k.signingKey!);
    return wrapPgpSigned(entity, signature, input);
  }

  const cms = await import('./smime/cms');
  const k = keys.smime ?? {};
  if (opts.sign && !k.signer) throw new Error('No unlocked S/MIME key to sign with');

  // Sign only: detached multipart/signed, readable without S/MIME (the
  // plugin's default signature format).
  if (opts.sign && !opts.encrypt) {
    const entity = buildMimeEntity(input);
    return wrapSmimeDetached(entity, await cms.smimeSignDetached(entity, k.signer!), input);
  }

  // Encrypt, signed first when asked (RFC 8551 sign-then-encrypt).
  if (!k.recipientCerts?.length && !k.senderCert) throw new Error('No recipient certificates available to encrypt to');
  let payload = buildMimeMessage(input);
  if (opts.sign) payload = cmsInnerEntity(await cms.smimeSignOpaque(payload, k.signer!), 'signed-data');
  const enveloped = await cms.smimeEncrypt(payload, k.recipientCerts ?? [], k.senderCert ?? k.recipientCerts![0]);
  return wrapCmsMessage(enveloped, 'enveloped-data', input);
}
