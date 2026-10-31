// Banner rows for a PGP / S/MIME status (#58).
import type { SecureStatus } from './secure-message';

export type BannerTone = 'ok' | 'warn' | 'error' | 'muted';
type Translate = (key: string, fallback: string, vars?: Record<string, string | number>) => string;

export interface BannerRow {
  key: string;
  tone: BannerTone;
  text: string;
}

/**
 * The banner rows for a PGP / S/MIME status, as the plugins' email-banner
 * slots show them (repos/plugins/bulwark-gpg/src/index.js EmailBanner,
 * repos/plugins/smime/src/ui.js bannerRows).
 */
export function secureBannerRows(status: SecureStatus, t: Translate): BannerRow[] {
  const rows: BannerRow[] = [];
  const kind = status.kind === 'pgp' ? 'OpenPGP' : 'S/MIME';
  if (status.encrypted) {
    if (status.decrypted) rows.push({ key: 'dec', tone: 'ok', text: t('encryption.banner.decrypted', 'Decrypted ({kind})', { kind }) });
    else if (status.lockedKeyIds?.length) rows.push({ key: 'locked', tone: 'warn', text: t('encryption.banner.locked', 'Encrypted ({kind}). Unlock your key to read it.', { kind }) });
    else if (status.unsupportedAlgorithm) rows.push({ key: 'alg', tone: 'error', text: t('encryption.banner.unsupported', 'Encrypted with {algorithm}, which the app cannot decrypt.', { algorithm: status.unsupportedAlgorithm }) });
    else if (status.noKey) rows.push({ key: 'nokey', tone: 'error', text: t('encryption.banner.no_key', 'Encrypted ({kind}) to a key that is not on this device.', { kind }) });
    else rows.push({ key: 'fail', tone: 'error', text: t('encryption.banner.failed', 'Could not decrypt: {reason}', { reason: status.error ?? '' }) });
  }
  if (status.signature === 'valid') {
    rows.push({
      key: 'sig',
      tone: status.signerMismatch ? 'warn' : 'ok',
      text: status.signerEmail
        ? t('encryption.banner.signed_by', 'Valid signature ({kind}) from {signer}', { kind, signer: status.signerEmail })
        : t('encryption.banner.signed', 'Valid signature ({kind})', { kind }),
    });
    if (status.signerMismatch) rows.push({ key: 'mismatch', tone: 'warn', text: t('encryption.banner.signer_mismatch', 'The signer is not the sender shown in From.') });
    if (status.selfSigned) rows.push({ key: 'self', tone: 'muted', text: t('encryption.banner.self_signed', 'The certificate is self-signed, not issued by a known authority.') });
  } else if (status.signature === 'invalid') {
    rows.push({
      key: 'sig',
      tone: 'error',
      text: status.error
        ? t('encryption.banner.invalid_reason', 'Invalid signature ({kind}): {reason}', { kind, reason: status.error })
        : t('encryption.banner.invalid', 'Invalid signature ({kind})', { kind }),
    });
  } else if (status.signature === 'unknown') {
    rows.push({ key: 'sig', tone: 'warn', text: t('encryption.banner.unknown_key', 'Signed ({kind}) with a key you have not imported.', { kind }) });
  }
  return rows;
}

