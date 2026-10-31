// Private key material for PGP and S/MIME (#58) lives in SecureStore only
// (Keychain / Keystore), never in AsyncStorage. A PGP private key or a .p12
// is often larger than the 2048 bytes SecureStore promises to hold in one
// value, so a secret is split over numbered items with a count item.

import * as SecureStore from 'expo-secure-store';

const CHUNK = 1800;
const PREFIX = 'bulwark_crypto_';

// Not restored from a backup onto another device, and only readable while
// the device is unlocked.
const options = (): SecureStore.SecureStoreOptions => ({ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });

function keyFor(id: string): string {
  return PREFIX + id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function setSecret(id: string, value: string): Promise<void> {
  const base = keyFor(id);
  await deleteSecret(id);
  const parts = Math.max(1, Math.ceil(value.length / CHUNK));
  for (let i = 0; i < parts; i++) {
    await SecureStore.setItemAsync(`${base}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK), options());
  }
  // The count goes last: a half-written secret reads as missing.
  await SecureStore.setItemAsync(`${base}.n`, String(parts), options());
}

export async function getSecret(id: string): Promise<string | null> {
  const base = keyFor(id);
  const n = Number(await SecureStore.getItemAsync(`${base}.n`, options()));
  if (!Number.isInteger(n) || n <= 0) return null;
  let out = '';
  for (let i = 0; i < n; i++) {
    const part = await SecureStore.getItemAsync(`${base}.${i}`, options());
    if (part == null) return null;
    out += part;
  }
  return out;
}

export async function deleteSecret(id: string): Promise<void> {
  const base = keyFor(id);
  const n = Number(await SecureStore.getItemAsync(`${base}.n`, options()).catch(() => null));
  await SecureStore.deleteItemAsync(`${base}.n`, options()).catch(() => undefined);
  const count = Number.isInteger(n) && n > 0 ? n : 0;
  for (let i = 0; i < count; i++) await SecureStore.deleteItemAsync(`${base}.${i}`, options()).catch(() => undefined);
}
