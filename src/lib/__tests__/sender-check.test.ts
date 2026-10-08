import { describe, it, expect } from 'vitest';
import { senderCheckText, canOfferTrustSender } from '../sender-check';
import { deriveHeaderInfo } from '../email-headers';
import type { MessageParams } from '../../i18n';

// Echoes the key and its params, so a test sees which string was picked.
const t = (key: string, _fallback?: string, params?: MessageParams) =>
  params ? `${key} ${JSON.stringify(params)}` : key;

describe('senderCheckText', () => {
  it('says nothing for a verified sender', () => {
    expect(senderCheckText(null, t)).toBeNull();
  });

  it('words an unverified sender', () => {
    expect(senderCheckText({ status: 'unverified', domain: 'bank.example' }, t)).toEqual({
      tone: 'warning',
      label: 'email_viewer.sender_check.unverified_label',
      message: 'email_viewer.sender_check.unverified {"domain":"bank.example"}',
      caution: 'email_viewer.sender_check.caution',
    });
  });

  it('names the sending host of an unverified sender', () => {
    expect(senderCheckText({ status: 'unverified', domain: 'bank.example', sentFrom: 'web1.hoster.example' }, t)?.message)
      .toBe('email_viewer.sender_check.unverified_sent_from {"domain":"bank.example","host":"web1.hoster.example"}');
  });

  it('words a failed check', () => {
    expect(senderCheckText({ status: 'failed', domain: 'bank.example' }, t)).toEqual({
      tone: 'danger',
      label: 'email_viewer.sender_check.failed_label',
      message: 'email_viewer.sender_check.failed {"domain":"bank.example"}',
      caution: 'email_viewer.sender_check.caution',
    });
  });

  it('names the sending host of a failed check', () => {
    expect(senderCheckText({ status: 'failed', domain: 'bank.example', sentFrom: 'evil.example' }, t)?.message)
      .toBe('email_viewer.sender_check.failed_sent_from {"domain":"bank.example","host":"evil.example"}');
  });

  it('falls back to the English text', () => {
    const english = (_key: string, fallback?: string, params?: MessageParams) =>
      (fallback ?? '').replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''));
    const text = senderCheckText({ status: 'failed', domain: 'bank.example', sentFrom: 'evil.example' }, english);
    expect(text?.label).toBe('Sender check failed');
    expect(text?.message).toBe("This message claims to be from bank.example, but it was sent from evil.example and failed bank.example's sender checks. It may be forged.");
    expect(text?.caution).toBe('Be careful with links, attachments and requests for passwords or payment details.');
  });
});

describe('canOfferTrustSender', () => {
  const headers = (value: string) => [{ name: 'Authentication-Results', value }];
  const from = [{ email: 'support@bank.example' }];

  it('offers it for a sender the checks back', () => {
    const info = deriveHeaderInfo({ headers: headers('mx; dkim=pass header.d=bank.example'), messageId: null, from });
    expect(canOfferTrustSender('support@bank.example', info.senderVerification)).toBe(true);
  });

  it('offers it when there are no results to judge by', () => {
    expect(canOfferTrustSender('support@bank.example', null)).toBe(true);
  });

  it('hides it for an unverified sender', () => {
    const info = deriveHeaderInfo({ headers: headers('mx; spf=none smtp.mailfrom=x@web1.hoster.example; dmarc=none'), messageId: null, from });
    expect(info.senderVerification?.status).toBe('unverified');
    expect(canOfferTrustSender('support@bank.example', info.senderVerification)).toBe(false);
  });

  it('hides it for a failed check', () => {
    const info = deriveHeaderInfo({ headers: headers('mx; dmarc=fail header.from=bank.example'), messageId: null, from });
    expect(info.senderVerification?.status).toBe('failed');
    expect(canOfferTrustSender('support@bank.example', info.senderVerification)).toBe(false);
  });

  it('hides it without a sender address', () => {
    expect(canOfferTrustSender(undefined, null)).toBe(false);
    expect(canOfferTrustSender('', null)).toBe(false);
  });
});
