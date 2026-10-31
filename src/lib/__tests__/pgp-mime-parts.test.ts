// A decrypted PGP/MIME message still listed its control parts as attachments:
// "Attachment.pgp-encrypted" (the version part) and "encrypted.asc".
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Email } from '../../api/types';
import type { SecureStatus } from '../crypto/secure-message';
import { hidesPgpMimeControlParts, pgpMimeControlParts } from '../pgp-mime-parts';

const version = { partId: '1', blobId: 'b-version', type: 'application/pgp-encrypted', size: 12 };
const payload = { partId: '2', blobId: 'b-payload', type: 'application/octet-stream', name: 'encrypted.asc', size: 900 };
const pgpMime = {
  bodyStructure: { type: 'multipart/encrypted', subParts: [version, payload] },
  attachments: [version, payload],
} as unknown as Email;

const plainWithPdf = {
  bodyStructure: {
    type: 'multipart/mixed',
    subParts: [{ partId: '1', type: 'text/plain' }, { partId: '2', blobId: 'b-pdf', type: 'application/pdf' }],
  },
  attachments: [{ partId: '2', blobId: 'b-pdf', type: 'application/pdf' }],
} as unknown as Email;

const status = (s: Partial<SecureStatus>): SecureStatus => ({
  kind: 'pgp', encrypted: true, decrypted: false, signature: 'none', ...s,
});

describe('PGP/MIME control parts', () => {
  it('are the parts of the multipart/encrypted', () => {
    const isControl = pgpMimeControlParts(pgpMime);
    expect(pgpMime.attachments!.filter((a) => !isControl(a))).toEqual([]);
  });

  it('are found by type when the structure is missing', () => {
    const isControl = pgpMimeControlParts({ attachments: [version, payload] } as unknown as Email);
    expect(isControl(version) && isControl(payload)).toBe(true);
  });

  it('leave other messages alone', () => {
    const isControl = pgpMimeControlParts(plainWithPdf);
    expect(plainWithPdf.attachments!.filter((a) => !isControl(a))).toHaveLength(1);
  });

  it('are hidden once decrypted, while opening and while a key is locked', () => {
    expect(hidesPgpMimeControlParts({ loading: false, status: status({ decrypted: true }) })).toBe(true);
    expect(hidesPgpMimeControlParts({ loading: true, status: null })).toBe(true);
    expect(hidesPgpMimeControlParts({ loading: false, status: status({ lockedKeyIds: ['k1'] }) })).toBe(true);
  });

  it('stay when the message cannot be decrypted, so the payload can be saved', () => {
    expect(hidesPgpMimeControlParts({ loading: false, status: status({ noKey: true }) })).toBe(false);
    expect(hidesPgpMimeControlParts({ loading: false, status: null })).toBe(false);
  });

  it('are filtered out of the reader chips', () => {
    const content = fs.readFileSync(path.resolve(__dirname, '../../components/email/MessageContent.tsx'), 'utf8');
    expect(content).toMatch(/hidePart=\{hidePart\}/);
    const chips = fs.readFileSync(path.resolve(__dirname, '../../components/email/AttachmentChips.tsx'), 'utf8');
    expect(chips).toMatch(/\.filter\(\(att\) => !hidePart\?\.\(att\)\)/);
  });
});
