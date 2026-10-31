import React from 'react';
import type { Email } from '../../api/types';
import { fetchBlobBytes } from '../../lib/email-export';
import { secureKindHint, openSecureMessage, type SecureKeyAccess, type SecureResult } from '../../lib/crypto/secure-message';
import {
  unlockedPgpKeys, ownKeys, allPgpPublicKeys, isUnlocked, unlockedSmimeKey, onUnlockChange, rememberSignerCertificate, rememberSignerPgpKey,
  unlockIfUnprotected,
} from '../../lib/crypto/keyring';
import { base64Decode } from '../../lib/crypto/mime';
import { usePolicyFeature } from '../../stores/policy-store';
import type { PgpKeyRecord, SmimeCertRecord } from '../../stores/crypto-keys-store';

/** The key store as the reader sees it (src/lib/crypto/keyring.ts). */
export function keyringAccess(): SecureKeyAccess {
  return {
    pgpDecryptionKeys: unlockedPgpKeys,
    pgpOwnKeys: () => (ownKeys('pgp') as PgpKeyRecord[]).map((k) => ({ id: k.id, publicKeyArmored: k.publicKeyArmored, unlocked: isUnlocked(k) })),
    pgpPublicKeys: allPgpPublicKeys,
    smimeKeys: () => (ownKeys('smime') as SmimeCertRecord[]).map((k) => ({ id: k.id, certificate: base64Decode(k.certificate), pkcs8: unlockedSmimeKey(k.id)?.pkcs8 })),
    rememberPgpKey: rememberSignerPgpKey,
    rememberCertificate: rememberSignerCertificate,
  };
}

const MAX_RAW_BYTES = 25 * 1024 * 1024;

// Results by message, so paging back to a message doesn't decrypt it again.
// Dropped whenever a key is unlocked or locked.
const cache = new Map<string, SecureResult | null>();
onUnlockChange(() => cache.clear());

export interface SecureMessageState {
  loading: boolean;
  result: SecureResult | null;
}

const IDLE: SecureMessageState = { loading: false, result: null };

/**
 * Decrypt / verify a PGP or S/MIME message for the reader (#58): the
 * plugins' onRenderEmailBody. Only messages whose structure or text hint at
 * PGP or S/MIME are downloaded (the raw message, by its blobId).
 */
export function useSecureMessage(email: Email, jmapAccountId?: string): SecureMessageState {
  const smimeAllowed = usePolicyFeature('smimeEnabled');
  const hint = React.useMemo(() => secureKindHint(email), [email]);
  const enabled = !!hint && !!email.blobId && (hint === 'pgp' || smimeAllowed) && (email.size ?? 0) <= MAX_RAW_BYTES;
  const cacheKey = `${jmapAccountId ?? ''}:${email.id}:${email.blobId}`;
  const [state, setState] = React.useState<SecureMessageState>(() => (enabled && cache.has(cacheKey) ? { loading: false, result: cache.get(cacheKey)! } : enabled ? { loading: true, result: null } : IDLE));
  const [generation, setGeneration] = React.useState(0);

  React.useEffect(() => onUnlockChange(() => setGeneration((n) => n + 1)), []);

  React.useEffect(() => {
    if (!enabled) {
      setState(IDLE);
      return;
    }
    if (cache.has(cacheKey)) {
      setState({ loading: false, result: cache.get(cacheKey)! });
      return;
    }
    let cancelled = false;
    setState((s) => (s.result ? s : { loading: true, result: null }));
    void (async () => {
      try {
        const raw = await fetchBlobBytes(email.blobId!, 'message.eml', 'message/rfc822', jmapAccountId);
        // A key without a passphrase unlocks without asking.
        for (const k of ownKeys('pgp')) await unlockIfUnprotected(k).catch(() => false);
        let result = await openSecureMessage(raw, email.from?.[0]?.email, keyringAccess());
        if (result?.status.kind === 'smime' && !smimeAllowed) result = null;
        if (cancelled) return;
        cache.set(cacheKey, result);
        setState({ loading: false, result });
      } catch (err) {
        console.warn('[reader] secure message failed', err);
        if (!cancelled) setState(IDLE);
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, cacheKey, email.blobId, email.from, jmapAccountId, smimeAllowed, generation]);

  return state;
}
