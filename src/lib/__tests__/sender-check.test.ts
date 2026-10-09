import { describe, it, expect } from 'vitest';
import { senderCheckText, trustSenderBannerMode, untrustedReplyAddresses, senderPassesCheck, passesFromHeaderInfo, viaIdentityBadge } from '../sender-check';
import { deriveHeaderInfo, getSenderVerification, parseAuthenticationResults } from '../email-headers';
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

describe('senderCheckText - bidi controls', () => {
  it('strips them from the domain and host it shows', () => {
    const text = senderCheckText({
      status: 'unverified',
      domain: 'bank\u202e.example\u2066',
      sentFrom: '\u202aweb1\u2069.hoster\u202c.example\u2067\u2068\u202b\u202d',
    }, t);
    expect(text?.message).toBe('email_viewer.sender_check.unverified_sent_from {"domain":"bank.example","host":"web1.hoster.example"}');
  });

  it('strips the directional marks too', () => {
    const text = senderCheckText({ status: 'unverified', domain: 'bank\u200f.ex\u200eample\u061c' }, t);
    expect(text?.message).toContain('"domain":"bank.example"');
  });
});

describe('trustSenderBannerMode', () => {
  const headers = (value: string) => [{ name: 'Authentication-Results', value }];
  const from = [{ email: 'support@bank.example' }];
  const passes = (results: string | null) =>
    passesFromHeaderInfo(deriveHeaderInfo({ headers: results ? headers(results) : [], messageId: null, from }, 'mx'), from[0].email);

  // "Always trust" only where trusting would let the next message load: a
  // message that passes the sender check.
  it('offers trust for a sender the checks back', () => {
    const ok = passes('mx; dkim=pass header.d=bank.example');
    expect(trustSenderBannerMode('support@bank.example', { listed: false, senderAuthenticated: ok })).toBe('offer_trust');
  });

  it('offers nothing for an untrusted sender whose message did not pass', () => {
    for (const results of [null, 'mx; spf=none smtp.mailfrom=x@web1.hoster.example; dmarc=none', 'mx; dmarc=fail header.from=bank.example']) {
      expect(trustSenderBannerMode('support@bank.example', { listed: false, senderAuthenticated: passes(results) })).toBe('none');
    }
    expect(trustSenderBannerMode('support@bank.example', { listed: false, senderAuthenticated: undefined })).toBe('none');
  });

  it('explains instead for a trusted sender whose message did not pass', () => {
    expect(trustSenderBannerMode('support@bank.example', { listed: true, senderAuthenticated: false })).toBe('trusted_unverified');
    expect(trustSenderBannerMode('support@bank.example', { listed: true, senderAuthenticated: undefined })).toBe('trusted_unverified');
  });

  // The sender-check banner above already says the message isn't verified.
  it('says nothing more for a trusted sender when the sender-check banner already warns', () => {
    expect(trustSenderBannerMode('support@bank.example', { listed: true, senderAuthenticated: false, senderWarned: true })).toBe('none');
    expect(trustSenderBannerMode('support@bank.example', { listed: true, senderAuthenticated: false, senderWarned: false })).toBe('trusted_unverified');
    expect(trustSenderBannerMode('support@bank.example', { listed: false, senderAuthenticated: true, senderWarned: true })).toBe('offer_trust');
  });

  it('offers nothing without a sender address', () => {
    expect(trustSenderBannerMode(undefined, { listed: false, senderAuthenticated: true })).toBe('none');
    expect(trustSenderBannerMode('', { listed: true, senderAuthenticated: false })).toBe('none');
  });
});

describe('sender alignment by registrable domain', () => {
  it('counts a DKIM pass for a sibling subdomain of the From domain', () => {
    const auth = parseAuthenticationResults('mx; dkim=pass header.d=mailer.bank.example');
    expect(getSenderVerification(auth, 'ceo@news.bank.example')).toBeNull();
  });

  it('does not count a pass for another tenant of a shared suffix', () => {
    const auth = parseAuthenticationResults('mx; dkim=pass header.d=evil.github.io');
    expect(getSenderVerification(auth, 'a@alice.github.io')?.status).toBe('unverified');
  });

  it('does not count a pass for a bare public suffix above the From domain', () => {
    // The old parent-or-subdomain rule took co.uk as a parent of bank.co.uk.
    const auth = parseAuthenticationResults('mx; dkim=pass header.d=co.uk');
    expect(getSenderVerification(auth, 'support@bank.co.uk')?.status).toBe('unverified');
  });
});

const fromBank = (results: string | null) => ({
  from: [{ name: 'CEO', email: 'CEO@Bank.example' }],
  replyTo: [{ email: ' Pay@Evil.example ' }],
  to: undefined as { email: string }[] | undefined,
  cc: undefined as { email: string }[] | undefined,
  headers: results ? [{ name: 'Authentication-Results', value: results }] : [],
  messageId: ['m1@bank.example'],
});
const forgedFromBank = fromBank('mx; spf=fail smtp.mailfrom=evil.example; dmarc=fail header.from=bank.example');
const unverifiedFromBank = fromBank('mx; spf=pass smtp.mailfrom=evil.example; dkim=pass header.d=evil.example');
const verifiedFromBank = fromBank('mx; spf=pass smtp.mailfrom=bank.example; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example');

describe('untrustedReplyAddresses', () => {
  it('lists the From and Reply-To of a failed or unverified message', () => {
    expect(untrustedReplyAddresses(forgedFromBank, 'mx')).toEqual(['ceo@bank.example', 'pay@evil.example']);
    expect(untrustedReplyAddresses(unverifiedFromBank, 'mx')).toEqual(['ceo@bank.example', 'pay@evil.example']);
  });

  // A pass on From says nothing about a Reply-To the signature may not cover
  // (a replayed DKIM-signed message with one added).
  it('on a verified message, lists only a Reply-To outside the From domain', () => {
    expect(untrustedReplyAddresses(verifiedFromBank, 'mx')).toEqual(['pay@evil.example']);
    expect(untrustedReplyAddresses({ ...verifiedFromBank, replyTo: [{ email: 'Billing@Mail.Bank.example' }] }, 'mx'))
      .toEqual([]);
    expect(untrustedReplyAddresses({ ...verifiedFromBank, replyTo: [{ email: 'x@bank.example.evil.example' }, { email: 'nodomain' }] }, 'mx'))
      .toEqual(['x@bank.example.evil.example', 'nodomain']);
    expect(untrustedReplyAddresses({ ...verifiedFromBank, replyTo: undefined }, 'mx')).toEqual([]);
  });

  // "Failed or couldn't be verified": only a positive pass trusts.
  it('flags a message with no results to judge by', () => {
    expect(untrustedReplyAddresses(fromBank(null), 'mx')).toEqual(['ceo@bank.example', 'pay@evil.example']);
    expect(untrustedReplyAddresses(verifiedFromBank, null)).toEqual(['ceo@bank.example', 'pay@evil.example']);
  });

  it('judges only by the owning server\'s results', () => {
    // A pass under another server's id is no pass.
    expect(untrustedReplyAddresses(verifiedFromBank, 'other.example')).toEqual(['ceo@bank.example', 'pay@evil.example']);
  });

  // A forger picks the To and Cc too: a reply-all must not trust them.
  it('lists every recipient of a message that did not pass, and of one that did only an outside Reply-To', () => {
    const recipients = { to: [{ email: 'me@ours.example' }, { email: 'Mule@Evil.example' }], cc: [{ email: 'cfo@bank.example' }] };
    expect(untrustedReplyAddresses({ ...forgedFromBank, ...recipients }, 'mx'))
      .toEqual(['ceo@bank.example', 'pay@evil.example', 'me@ours.example', 'mule@evil.example', 'cfo@bank.example']);
    expect(untrustedReplyAddresses({ ...verifiedFromBank, ...recipients }, 'mx')).toEqual(['pay@evil.example']);
  });

  it('lists each address once', () => {
    expect(untrustedReplyAddresses({ ...forgedFromBank, replyTo: [{ email: 'ceo@bank.example' }] }, 'mx'))
      .toEqual(['ceo@bank.example']);
  });
});

describe('senderPassesCheck', () => {
  it('passes only an aligned pass in the owning server\'s results', () => {
    expect(senderPassesCheck(verifiedFromBank, 'mx')).toBe(true);
    expect(senderPassesCheck(forgedFromBank, 'mx')).toBe(false);
    expect(senderPassesCheck(unverifiedFromBank, 'mx')).toBe(false);
  });

  it('does not pass a message with no results to judge by', () => {
    expect(senderPassesCheck(fromBank(null), 'mx')).toBe(false);
    expect(senderPassesCheck(verifiedFromBank, 'other.example')).toBe(false);
    expect(senderPassesCheck(verifiedFromBank, null)).toBe(false);
  });
});

describe('viaIdentityBadge', () => {
  const me = { id: 'i1', name: 'Me', email: 'me@ours.example' } as never;
  const alias = { id: 'i2', name: 'Sales', email: 'sales@ours.example' } as never;
  const fromMe = (results: string | null) => ({
    from: [{ email: 'Me@Ours.example' }],
    to: [{ email: 'someone@else.example' }],
    headers: results ? [{ name: 'Authentication-Results', value: results }] : [],
    messageId: ['m@ours.example'],
  });
  const info = (email: ReturnType<typeof fromMe>) => deriveHeaderInfo(email, 'mx');

  it('shows "sent as" only on a message whose From passed the sender check', () => {
    const passed = fromMe('mx; dkim=pass header.d=ours.example');
    expect(viaIdentityBadge(passed, [me, alias], info(passed))).toEqual({ identity: me, direction: 'from' });
    // A forger's own header, or none at all, leaves no pinned results: no badge.
    for (const forged of [fromMe(null), fromMe('evil.example; dkim=pass header.d=ours.example'), fromMe('mx; dkim=fail header.d=ours.example')]) {
      expect(viaIdentityBadge(forged, [me, alias], info(forged))).toBeNull();
    }
  });

  it('shows "received at" for a non-default identity unless the message reads as spoofed', () => {
    const toAlias = { ...fromMe(null), from: [{ email: 'x@else.example' }], to: [{ email: 'sales@ours.example' }] };
    expect(viaIdentityBadge(toAlias, [me, alias], deriveHeaderInfo(toAlias, 'mx'))).toEqual({ identity: alias, direction: 'to' });
    expect(viaIdentityBadge(toAlias, [me], deriveHeaderInfo(toAlias, 'mx'))).toBeNull();
    const spoofed = { ...toAlias, headers: [{ name: 'Authentication-Results', value: 'mx; dmarc=fail header.from=else.example' }] };
    expect(viaIdentityBadge(spoofed, [me, alias], deriveHeaderInfo(spoofed, 'mx'))).toBeNull();
  });
});
