import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { clientCertCopy } from '../client-cert-copy';

// Settings > Security > TLS client certificate told iPhone users to install
// the certificate in Android settings. iOS imports a .p12/.pfx file into the
// app instead, and Clear removes it from the app.

const t = (_key: string, fallback: string) => fallback;
const keys = (os: string) => {
  const used: string[] = [];
  clientCertCopy(os, (key, fallback) => { used.push(key); return fallback; });
  return used;
};

describe('client certificate texts', () => {
  it('speaks of a certificate file on iOS', () => {
    const copy = clientCertCopy('ios', t);
    expect(copy.hint).toBe('Pick the certificate file (.p12 or .pfx) in Files and enter its password.');
    expect(copy.clearMessage).toContain('removed from the app');
    expect(`${copy.description} ${copy.hint} ${copy.clearMessage}`).not.toMatch(/Android/);
    expect(keys('ios')).toEqual([
      'settings.security.client_cert.description_ios',
      'settings.security.client_cert.hint_ios',
      'settings.security.client_cert.clear_message_ios',
    ]);
  });

  it('keeps the Android texts on Android', () => {
    expect(keys('android')).toEqual([
      'settings.security.client_cert.description',
      'settings.security.client_cert.hint',
      'settings.security.client_cert.clear_message',
    ]);
    expect(clientCertCopy('android', t).clearMessage).toContain('stays installed in Android');
  });

  it('is what the settings section shows', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'AccountSecuritySettings.tsx'), 'utf8');
    expect(src).toMatch(/const copy = clientCertCopy\(Platform\.OS, t\);/);
    expect(src).toMatch(/description=\{copy\.description\}/);
    expect(src).toMatch(/\{copy\.hint\}/);
    expect(src).toMatch(/copy\.clearMessage,/);
    expect(src).not.toMatch(/t\('settings\.security\.client_cert\.(hint|description|clear_message)'/);
  });
});
