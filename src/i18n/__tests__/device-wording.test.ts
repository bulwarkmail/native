// The app runs on phones and tablets: its copy says "this device", not "this
// phone" ("installed on this phone", "your phone's text size" on a tablet).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RN_DIR = join(__dirname, '..', '..', '..', 'locales', 'rn');

function flatten(obj: Record<string, unknown>, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out);
    else out.set(key, v);
  }
  return out;
}

const read = (code: string) => flatten(JSON.parse(readFileSync(join(RN_DIR, `${code}.json`), 'utf8')));

// The keys that spoke of the user's phone.
const DEVICE_KEYS = [
  'calendar.settings.time_zone_desc',
  'login.mobile.err_pair_network_detail',
  'login.mobile.server_cert_hint',
  'settings.about.privacy_desc',
  'settings.accessibility.reduce_motion.description_mobile',
  'settings.accessibility.text_size.description_mobile',
  'settings.backup.description',
  'settings.offline.description_short',
  'settings.privacy.phone_title',
];

// "Phone" in each language, as the overlays had it.
const PHONE: Record<string, RegExp> = {
  en: /\bphone/i, ar: /هاتف/, ca: /telèfon/i, cs: /telefon/i, da: /telefon/i, de: /telefon/i,
  es: /teléfono/i, et: /telefon/i, fa: /تلفن/, fr: /téléphone/i, he: /טלפון/, hu: /telefon/i,
  it: /telefono/i, ja: /スマートフォン/, ko: /휴대폰/, lv: /tālru/i, mn: /утас|утсанд|утсан/i, nb: /telefon/i,
  nl: /telefoon/i, pl: /telefon/i, pt: /celular/i, ro: /telefon/i, ru: /телефон/i, sk: /telefón/i,
  th: /โทรศัพท์/, tr: /telefon/i, uk: /телефон/i, zh: /手机/, 'zh-TW': /手機/,
};

describe('device-neutral wording', () => {
  const codes = readdirSync(RN_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

  it('covers every overlay', () => {
    expect(codes.sort()).toEqual(Object.keys(PHONE).sort());
  });

  it.each(codes)('%s says device, not phone', (code) => {
    const overlay = read(code);
    for (const key of DEVICE_KEYS) {
      const value = overlay.get(key);
      expect(typeof value, `${code} ${key}`).toBe('string');
      expect(value as string, `${code} ${key}`).not.toMatch(PHONE[code]);
    }
  });

  it('leaves no "phone" for the device in the English app copy', () => {
    // A phone call and a contact's phone number are still phones.
    const allowed = new Set(['encryption.lookup_confirm', 'structured_mail_calendar.description.phone']);
    const offenders = [...read('en')]
      .filter(([key, value]) => typeof value === 'string' && /\bphone\b/i.test(value) && !allowed.has(key))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });
});
