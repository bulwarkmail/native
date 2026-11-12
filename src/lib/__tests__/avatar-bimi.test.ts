import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  bimiLogoUrl,
  brandIndicatorDomain,
  isNoLogoImage,
  markBrandLogoFailed,
  resetBrandLogosForTests,
  showBrandLogo,
} from '../avatar-bimi';
import { avatarContent } from '../avatar-utils';
import { internalMailDomains, policyInternalDomains } from '../avatar-internal-domains';
import { LIST_AUTH_RESULTS_PROPERTY } from '../email-headers';
import type { Email } from '../../api/types';

// BIMI logos as the webmail shows them (components/ui/avatar.tsx,
// lib/email-headers.ts brandIndicatorDomain, app/api/bimi).

const PASS = 'mx.example.org; spf=pass smtp.mailfrom=bank.example; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example';
const FAIL = 'mx.example.org; spf=fail smtp.mailfrom=evil.example; dkim=none; dmarc=fail header.from=bank.example';
const OTHER_DOMAIN = 'mx.example.org; spf=pass smtp.mailfrom=other.example; dkim=pass header.d=other.example; dmarc=pass header.from=other.example';
const NO_DMARC = 'mx.example.org; spf=pass smtp.mailfrom=bank.example; dkim=pass header.d=bank.example';
const SPOOFED_PASS = 'mx.example.org; spf=fail smtp.mailfrom=bank.example; dkim=none; dmarc=pass header.from=bank.example';

function row(auth?: string[], from = 'billing@bank.example'): Email {
  return {
    id: 'm1', threadId: 't1', mailboxIds: {}, keywords: {}, size: 1, receivedAt: '2026-10-31T10:00:00Z',
    hasAttachment: false, from: [{ name: 'Bank', email: from }],
    ...(auth ? { [LIST_AUTH_RESULTS_PROPERTY]: auth } : {}),
  } as Email;
}

beforeEach(() => resetBrandLogosForTests());

// Mail handed in on the same server has no Authentication-Results, so mail
// between the organisation's own domains never showed its logo (webmail
// 531358eb3).
describe("brandIndicatorDomain for mail between the organisation's domains", () => {
  it('names an internal From domain of a message without any Authentication-Results', () => {
    const internal = internalMailDomains(['me@bank.example', '*@Bänk.example'], ['corp.example']);
    expect(internal).toEqual(['bank.example', 'xn--bnk-qla.example', 'corp.example']);
    expect(brandIndicatorDomain(row(), internal)).toBe('bank.example');
    expect(brandIndicatorDomain(row(undefined, 'hr@eu.corp.example'), internal)).toBe('eu.corp.example');
    expect(brandIndicatorDomain(row(undefined, 'x@other.example'), internal)).toBeUndefined();
    expect(brandIndicatorDomain(row(), [])).toBeUndefined();
    // The same domain's mail from outside carries the header and still needs the pass.
    expect(brandIndicatorDomain(row([NO_DMARC]), internal)).toBeUndefined();
    expect(brandIndicatorDomain(row([FAIL]), internal)).toBeUndefined();
  });

  it("reads the admin's domains from the policy's external mail part", () => {
    expect(policyInternalDomains({ externalMail: { domains: ['corp.example', 3] } })).toEqual(['corp.example']);
    expect(policyInternalDomains(undefined)).toEqual([]);
  });

  it('is handed the internal domains wherever a sender avatar shows the logo', () => {
    const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
    expect(src('screens/EmailListScreen.tsx')).toMatch(/brandIndicatorDomain\(item, internalDomains\)/);
    expect(src('screens/UnifiedInboxScreen.tsx')).toMatch(/brandIndicatorDomain\(item, internalDomains\)/);
    expect(src('components/email/MessageHeader.tsx')).toMatch(/brandIndicatorDomain\(email, internalDomains\)/);
    expect(src('components/email/ThreadMessageCard.tsx')).toMatch(/brandIndicatorDomain\(email, internalDomains\)/);
  });
});

describe('brandIndicatorDomain', () => {
  it('names the From domain of a message that passed DMARC for it, from the list property or the headers', () => {
    expect(brandIndicatorDomain(row([PASS]))).toBe('bank.example');
    const full = { ...row(), headers: [{ name: 'Authentication-Results', value: ` ${PASS}` }] };
    expect(brandIndicatorDomain(full)).toBe('bank.example');
    expect(brandIndicatorDomain(row([PASS], 'Billing@BANK.example'))).toBe('bank.example');
  });

  it('names none for a failed, missing or foreign DMARC result, or a spoofed message', () => {
    expect(brandIndicatorDomain(row([FAIL]))).toBeUndefined();
    expect(brandIndicatorDomain(row([NO_DMARC]))).toBeUndefined();
    expect(brandIndicatorDomain(row([OTHER_DOMAIN]))).toBeUndefined();
    expect(brandIndicatorDomain(row([SPOOFED_PASS]))).toBeUndefined();
    expect(brandIndicatorDomain(row())).toBeUndefined();
    expect(brandIndicatorDomain(undefined)).toBeUndefined();
  });
});

describe('bimiLogoUrl', () => {
  it('asks the account webmail for the domain', () => {
    expect(bimiLogoUrl('https://mail.example.org/', 'bank.example')).toBe('https://mail.example.org/api/bimi?domain=bank.example');
    expect(bimiLogoUrl('https://mail.example.org/webmail', 'a&b.example')).toBe('https://mail.example.org/webmail/api/bimi?domain=a%26b.example');
  });

  it('has none without a webmail', () => {
    expect(bimiLogoUrl(null, 'bank.example')).toBeNull();
    expect(bimiLogoUrl('', 'bank.example')).toBeNull();
    expect(bimiLogoUrl('javascript:alert(1)', 'bank.example')).toBeNull();
  });
});

describe('showBrandLogo', () => {
  const base = { senderFavicons: true, email: 'billing@bank.example', brandDomain: 'bank.example', webmailUrl: 'https://mail.example.org' };

  it('shows the logo for the address whose message passed', () => {
    expect(showBrandLogo(base)).toBe(true);
  });

  it('follows the sender favicon switch, which is off by default', () => {
    expect(showBrandLogo({ ...base, senderFavicons: false })).toBe(false);
  });

  it('shows none for another address than the one the check was for', () => {
    expect(showBrandLogo({ ...base, email: 'someone@elsewhere.example' })).toBe(false);
    expect(showBrandLogo({ ...base, email: 'news@mail.bank.example' })).toBe(false);
  });

  it('shows none without a webmail or a passing domain', () => {
    expect(showBrandLogo({ ...base, webmailUrl: undefined })).toBe(false);
    expect(showBrandLogo({ ...base, brandDomain: undefined })).toBe(false);
  });

  it('stops asking for a logo that failed this session', () => {
    markBrandLogoFailed('https://mail.example.org/api/bimi?domain=bank.example');
    expect(showBrandLogo(base)).toBe(false);
  });

  it('reads the 1x1 answer as no logo', () => {
    expect(isNoLogoImage({ width: 1, height: 1 })).toBe(true);
    expect(isNoLogoImage({ width: 128, height: 128 })).toBe(false);
    expect(isNoLogoImage(undefined)).toBe(false);
  });
});

describe('avatar order with a BIMI logo', () => {
  it('keeps the warning shield and the contact photo ahead of the logo, and the logo ahead of the favicon', () => {
    expect(avatarContent({ senderWarning: 'Sender check failed', hasPhoto: true, showBrand: true, showFavicon: true })).toBe('warning');
    expect(avatarContent({ hasPhoto: true, showBrand: true, showFavicon: true })).toBe('photo');
    expect(avatarContent({ hasPhoto: false, showBrand: true, showFavicon: true })).toBe('brand');
    expect(avatarContent({ hasPhoto: false, showBrand: false, showFavicon: true })).toBe('favicon');
  });

  it('draws the logo in SenderAvatar under the favicon switch, never for a warned sender', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'components', 'SenderAvatar.tsx'), 'utf8');
    // senderFavicons there is the setting, off for disabled images and a warned sender.
    expect(source).toContain("const senderFavicons = useSettingsStore((s) => s.senderFavicons) && !disableImages && !warned;");
    expect(source).toContain('showBrandLogo({ senderFavicons, email, brandDomain, webmailUrl })');
    expect(source).toContain('const webmailUrl = useAccountStore((s) => s.accounts.find((a) => a.id === s.activeAccountId)?.webmailUrl ?? null);');
    expect(source).toMatch(/if \(content === 'brand' && brandUrl\) \{[\s\S]*?source=\{\{ uri: brandUrl \}\}[\s\S]*?onError=\{handleBrandFailed\}/);
  });
});
