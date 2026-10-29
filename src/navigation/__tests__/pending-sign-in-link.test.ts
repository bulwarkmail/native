import { describe, it, expect, beforeEach } from 'vitest';
import { acceptSignInLink, routeParkedSignInLink } from '../linking';
import {
  setPendingSignInLink,
  signInLinkNeedsConfirmation,
  usePendingSignInLinkStore,
} from '../pending-sign-in-link';
import type { QrLoginPayload } from '../../lib/oauth';
import { MAX_ACCOUNTS } from '../../lib/account-utils';

// A `bulwarkmail://` link from outside the app (any web page, one tap; any
// installed app, no tap) names a webmail and a code of the sender's choosing.
// It must not be redeemed or opened until the user says Continue; a scanned
// or pasted one is the user's own doing in the app and runs straight away.

const code = 'c0ffee'.repeat(10) + 'beef';
const link = (server: string) =>
  `bulwarkmail://pair?server=${encodeURIComponent(server)}&code=${code}`;
const ATTACKER = link('https://attacker.example');
const OTHER = link('https://other.example');

const store = () => usePendingSignInLinkStore.getState();

beforeEach(() => store().clear());

describe('sign-in link confirmation', () => {
  it('asks for links from outside the app, not for scanned or pasted ones', () => {
    expect(signInLinkNeedsConfirmation('external')).toBe(true);
    expect(signInLinkNeedsConfirmation('in-app')).toBe(false);
  });

  it('holds an external link until the user continues, then runs it once', () => {
    acceptSignInLink(ATTACKER);
    const taken = store().take();
    expect(taken).toMatchObject({ needsConfirmation: true, payload: { kind: 'pair', webmailUrl: 'https://attacker.example', code } });
    // Taken for the dialog, not handed out to run.
    expect(store().pending).toBeNull();
    expect(store().awaitingConfirmation?.id).toBe(taken!.id);
    expect(store().take()).toBeNull();

    expect(store().confirm(taken!.id)).toEqual({ kind: 'pair', webmailUrl: 'https://attacker.example', code });
    expect(store().awaitingConfirmation).toBeNull();
    // A second Continue (or a stale dialog) runs nothing.
    expect(store().confirm(taken!.id)).toBeNull();
  });

  it('forgets a cancelled link, so nothing redeems it later', () => {
    acceptSignInLink(ATTACKER);
    const taken = store().take()!;
    expect(store().discard(taken.id)).toBe(true);
    expect(store().confirm(taken.id)).toBeNull();
    expect(store().take()).toBeNull();
    expect(store().pending).toBeNull();
    expect(store().awaitingConfirmation).toBeNull();
    expect(store().discard(taken.id)).toBe(false);
  });

  it('drops links delivered while the dialog is open instead of swapping them in', () => {
    acceptSignInLink(ATTACKER);
    const shown = store().take()!;
    // A second 'url' event, or getInitialURL delivering again.
    expect(acceptSignInLink(OTHER)).toBe(true);
    expect(acceptSignInLink(ATTACKER)).toBe(true);
    expect(store().pending).toBeNull();
    expect(store().take()).toBeNull();
    // Continue runs the link the dialog named, nothing else.
    expect(store().confirm(shown.id)).toMatchObject({ webmailUrl: 'https://attacker.example' });
    expect(store().take()).toBeNull();
  });

  it('asks again when a link is delivered again after the dialog closed', () => {
    acceptSignInLink(ATTACKER);
    const first = store().take()!;
    store().discard(first.id);

    acceptSignInLink(ATTACKER);
    const again = store().take()!;
    expect(again.needsConfirmation).toBe(true);
    expect(again.id).not.toBe(first.id);
    // The cancelled dialog's id cannot confirm the new delivery.
    expect(store().confirm(first.id)).toBeNull();
    expect(store().awaitingConfirmation?.id).toBe(again.id);
  });

  it('keeps the newest of two links parked before the login screen takes one', () => {
    acceptSignInLink(ATTACKER);
    acceptSignInLink(OTHER);
    expect(store().take()).toMatchObject({ needsConfirmation: true, payload: { webmailUrl: 'https://other.example' } });
  });

  it('runs an in-app link without a dialog', () => {
    const payload: QrLoginPayload = { kind: 'connect', webmailUrl: 'https://mail.example.com' };
    expect(setPendingSignInLink(payload, 'in-app')).toBe(true);
    expect(store().take()).toMatchObject({ needsConfirmation: false, payload });
    expect(store().awaitingConfirmation).toBeNull();
    expect(store().pending).toBeNull();
  });
});

describe('refused sign-in links', () => {
  it('parks a pairing link for a plain-http webmail as a refusal, with nothing to run', () => {
    expect(acceptSignInLink(link('http://mail.example.com'))).toBe(true);
    expect(store().pending).toBeNull();
    expect(store().take()).toBeNull();
    const refusal = store().takeRefusal();
    expect(refusal).toMatchObject({ name: 'PairingError', reason: 'insecure', host: 'mail.example.com' });
    expect(store().takeRefusal()).toBeNull();
  });

  it('ignores other broken sign-in links, as before', () => {
    expect(acceptSignInLink(`bulwarkmail://pair?server=${encodeURIComponent('https://mail.example.com')}`)).toBe(false);
    expect(acceptSignInLink('bulwarkmail://unlock?server=https://mail.example.com')).toBe(false);
    expect(store().refusal).toBeNull();
    expect(store().pending).toBeNull();
  });
});

describe('routeParkedSignInLink (signed in)', () => {
  it('opens Add account while there is room', () => {
    acceptSignInLink(ATTACKER);
    expect(routeParkedSignInLink(MAX_ACCOUNTS - 1)).toBe('add-account');
    // Still parked for Add account's login screen.
    expect(store().pending).not.toBeNull();
  });

  it('drops the link and reports the limit when the registry is full, so no code is spent', () => {
    acceptSignInLink(ATTACKER);
    expect(routeParkedSignInLink(MAX_ACCOUNTS)).toBe('account-limit');
    expect(store().pending).toBeNull();
    expect(store().take()).toBeNull();

    acceptSignInLink(link('http://mail.example.com'));
    expect(routeParkedSignInLink(MAX_ACCOUNTS)).toBe('account-limit');
    expect(store().refusal).toBeNull();
  });

  it('does nothing when no link is parked', () => {
    expect(routeParkedSignInLink(0)).toBe('none');
    expect(routeParkedSignInLink(MAX_ACCOUNTS)).toBe('none');
  });

  it('leaves a link the dialog is asking about alone', () => {
    acceptSignInLink(ATTACKER);
    const shown = store().take()!;
    expect(routeParkedSignInLink(MAX_ACCOUNTS)).toBe('none');
    expect(store().confirm(shown.id)).not.toBeNull();
  });
});
