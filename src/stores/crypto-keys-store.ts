// The PGP keys and S/MIME certificates the app knows (#58): your own (with a
// private key in SecureStore) and other people's (public only). The webmail
// plugins keep the same lists in IndexedDB (repos/plugins/bulwark-gpg/src/
// key-storage.js, repos/plugins/smime/src/key-storage.js).
//
// Only public material and metadata are persisted here (AsyncStorage); a
// private PGP key or a .p12 goes to SecureStore (src/lib/crypto/secret-
// store.ts) under the record's id. The list is per device, not per account:
// a recipient's key is the same whichever account you write from.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createPersistStorage } from './persist-storage';

export interface PgpKeyRecord {
  kind: 'pgp';
  /** Lower-case fingerprint. */
  id: string;
  fingerprint: string;
  keyID: string;
  emails: string[];
  userIDs: string[];
  created: string;
  expiration: string | null;
  algorithm: string;
  publicKeyArmored: string;
  /** The private key is in SecureStore under `pgp.<id>`. */
  hasPrivate: boolean;
  source: 'import' | 'keyserver' | 'message' | 'contact';
  addedAt: string;
}

export interface SmimeCertRecord {
  kind: 'smime';
  /** SHA-256 fingerprint of the certificate. */
  id: string;
  fingerprint: string;
  emails: string[];
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  algorithm: string;
  /** Base64 DER. */
  certificate: string;
  chain: string[];
  canSign: boolean;
  canEncrypt: boolean;
  /** The .p12 is in SecureStore under `smime.<id>`. */
  hasPrivate: boolean;
  source: 'import' | 'message' | 'contact';
  addedAt: string;
}

export type CryptoKeyRecord = PgpKeyRecord | SmimeCertRecord;

interface CryptoKeysState {
  keys: CryptoKeyRecord[];
  /** Add or replace (by kind + id); a public import never drops a private key. */
  upsert: (record: CryptoKeyRecord) => void;
  remove: (kind: CryptoKeyRecord['kind'], id: string) => void;
}

/** Merge a record into the list; a public-only copy keeps the private flag. */
export function upsertRecord(keys: CryptoKeyRecord[], record: CryptoKeyRecord): CryptoKeyRecord[] {
  const i = keys.findIndex((k) => k.kind === record.kind && k.id === record.id);
  if (i < 0) return [...keys, record];
  const prev = keys[i];
  const merged = { ...record, hasPrivate: record.hasPrivate || prev.hasPrivate, source: prev.hasPrivate ? prev.source : record.source } as CryptoKeyRecord;
  const next = keys.slice();
  next[i] = merged;
  return next;
}

export const useCryptoKeysStore = create<CryptoKeysState>()(
  persist(
    (set, get) => ({
      keys: [],
      upsert: (record) => set({ keys: upsertRecord(get().keys, record) }),
      remove: (kind, id) => set({ keys: get().keys.filter((k) => !(k.kind === kind && k.id === id)) }),
    }),
    {
      name: 'crypto-keys',
      storage: createPersistStorage(),
      partialize: (state) => ({ keys: state.keys }),
    },
  ),
);

const EMPTY: CryptoKeyRecord[] = [];

/** Records for an address (lower-cased compare). */
export function keysForEmail(keys: CryptoKeyRecord[], email: string): CryptoKeyRecord[] {
  const e = email.trim().toLowerCase();
  if (!e) return EMPTY;
  return keys.filter((k) => k.emails.includes(e));
}

/** Is this record usable now (not expired)? */
export function isRecordCurrent(record: CryptoKeyRecord, now = Date.now()): boolean {
  if (record.kind === 'pgp') return !record.expiration || Date.parse(record.expiration) > now;
  return Date.parse(record.notAfter) > now && Date.parse(record.notBefore) <= now;
}
