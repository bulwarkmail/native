import { describe, it, expect, vi } from 'vitest';
import { handleDeepLink, parseDeepLink, shareToDeepLink } from '../linking';
import { usePendingSettingsTab } from '../pending-settings-tab';
import { usePendingCalendarOpen } from '../pending-calendar-open';

describe('parseDeepLink', () => {
  it('parses app-scheme mail links', () => {
    expect(parseDeepLink('bulwarkmobile://mail/message/M1')).toEqual({ kind: 'message', emailId: 'M1', accountId: undefined });
    expect(parseDeepLink('bulwarkmobile://mail/thread/T1?account=acc')).toEqual({ kind: 'thread', threadId: 'T1', accountId: 'acc' });
    expect(parseDeepLink('bulwarkmobile://mail/folder/inbox')).toEqual({ kind: 'folder', ref: 'inbox', accountId: undefined });
    expect(parseDeepLink('bulwarkmobile://mail')).toEqual({ kind: 'folder', ref: 'inbox', accountId: undefined });
  });

  it('parses webmail https permalinks, ignoring host and locale prefix', () => {
    expect(parseDeepLink('https://mail.example.com/mail/message/abc%2Fdef')).toEqual({ kind: 'message', emailId: 'abc/def', accountId: undefined });
    expect(parseDeepLink('https://mail.example.com/de/contacts/C9')).toEqual({ kind: 'contact', contactId: 'C9' });
    expect(parseDeepLink('https://mail.example.com/mail?email=legacy')).toEqual({ kind: 'message', emailId: 'legacy', accountId: undefined });
  });

  it('parses calendar, contacts, files and settings links', () => {
    expect(parseDeepLink('bulwarkmobile://calendar/event/E1')).toEqual({ kind: 'calendar', eventId: 'E1' });
    expect(parseDeepLink('bulwarkmobile://calendar/week/2026-08-29')).toEqual({ kind: 'calendar', date: '2026-08-29' });
    expect(parseDeepLink('bulwarkmobile://contacts')).toEqual({ kind: 'contacts' });
    expect(parseDeepLink('bulwarkmobile://files')).toEqual({ kind: 'files' });
    expect(parseDeepLink('bulwarkmobile://settings/notifications')).toEqual({ kind: 'settings', tab: 'notifications' });
    expect(parseDeepLink('bulwarkmobile://settings')).toEqual({ kind: 'settings', tab: undefined });
  });

  it('turns mailto: into a compose link', () => {
    expect(parseDeepLink('mailto:a@b.co?subject=Hi&cc=c@d.co')).toEqual({
      kind: 'compose',
      to: [{ email: 'a@b.co' }],
      cc: [{ email: 'c@d.co' }],
      bcc: [],
      subject: 'Hi',
      body: undefined,
    });
    expect(parseDeepLink('mailto:nope')).toBeNull();
  });

  it('reads the link MainActivity builds from a SENDTO mailto: intent and its extras', () => {
    // SENDTO mailto: + EXTRA_EMAIL/CC/BCC/SUBJECT/TEXT, each value Uri.encode()d.
    expect(parseDeepLink(
      'mailto:?to=bob%40partner.example&cc=carol%40partner.example&bcc=dave%40partner.example'
      + '&subject=Hi%20there&body=Line%201%0ALine%202',
    )).toEqual({
      kind: 'compose',
      to: [{ email: 'bob@partner.example' }],
      cc: [{ email: 'carol@partner.example' }],
      bcc: [{ email: 'dave@partner.example' }],
      subject: 'Hi there',
      body: 'Line 1\nLine 2',
    });
    // An address in the URI itself plus EXTRA_EMAIL.
    expect(parseDeepLink('mailto:bob@partner.example?to=eve%40partner.example')).toMatchObject({
      to: [{ email: 'bob@partner.example' }, { email: 'eve@partner.example' }],
    });
  });

  it('opens the composer for a mailto: with a sub-address', () => {
    expect(parseDeepLink('mailto:alice+news@partner.example?subject=a+b')).toMatchObject({
      kind: 'compose',
      to: [{ email: 'alice+news@partner.example' }],
      subject: 'a+b',
    });
  });

  it('parses app compose links once per recipient, with form-encoded spaces', () => {
    expect(parseDeepLink('bulwarkmobile://compose?to=alice%2Bnews@partner.example&subject=Hello+World&body=1%2B1')).toEqual({
      kind: 'compose',
      to: [{ email: 'alice+news@partner.example' }],
      cc: [],
      subject: 'Hello World',
      body: '1+1',
    });
  });

  it('rejects unknown links', () => {
    expect(parseDeepLink('bulwarkmobile://whatever')).toBeNull();
    expect(parseDeepLink('garbage')).toBeNull();
    expect(parseDeepLink('')).toBeNull();
  });
});

describe('handleDeepLink', () => {
  const nav = () => ({
    isReady: () => true,
    navigate: vi.fn(),
  });

  it('resolves a message to its thread before opening the reader', async () => {
    const navigation = nav();
    const ok = await handleDeepLink(
      { kind: 'message', emailId: 'M1' },
      { navigation: navigation as never, resolveThreadId: async () => 'T1' },
    );
    expect(ok).toBe(true);
    expect(navigation.navigate).toHaveBeenCalledWith('EmailThread', { emailId: 'M1', threadId: 'T1' });
  });

  it('gives up when the message cannot be loaded', async () => {
    const navigation = nav();
    const ok = await handleDeepLink(
      { kind: 'message', emailId: 'M1' },
      { navigation: navigation as never, resolveThreadId: async () => null },
    );
    expect(ok).toBe(false);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('opens the event a calendar link names, also on a shared calendar', async () => {
    const navigation = nav();
    expect(parseDeepLink('https://mail.example.com/calendar/event/E1?account=acc-2'))
      .toEqual({ kind: 'calendar', eventId: 'E1', jmapAccountId: 'acc-2' });

    await handleDeepLink(
      { kind: 'calendar', eventId: 'E1', jmapAccountId: 'acc-2' },
      { navigation: navigation as never, resolveThreadId: async () => null },
    );
    expect(usePendingCalendarOpen.getState().consume()).toEqual({
      kind: 'event', eventId: 'acc-2:E1', serverId: 'E1', accountId: 'acc-2',
    });
    expect(navigation.navigate).toHaveBeenCalledWith('MainTabs', { screen: 'Calendar' });

    // A date or view link just opens the tab.
    await handleDeepLink(
      { kind: 'calendar', date: '2026-08-29' },
      { navigation: navigation as never, resolveThreadId: async () => null },
    );
    expect(usePendingCalendarOpen.getState().consume()).toBeNull();
  });

  it('parks the settings tab and opens the Settings tab', async () => {
    const navigation = nav();
    await handleDeepLink(
      { kind: 'settings', tab: 'updates' },
      { navigation: navigation as never, resolveThreadId: async () => null },
    );
    expect(usePendingSettingsTab.getState().consume()).toBe('updates');
    expect(usePendingSettingsTab.getState().consume()).toBeNull();
    expect(navigation.navigate).toHaveBeenCalledWith('MainTabs', { screen: 'Settings' });
  });

  it('opens the composer with prefilled recipients', async () => {
    const navigation = nav();
    await handleDeepLink(
      { kind: 'compose', to: [{ email: 'a@b.co' }], cc: [], subject: 'S', body: 'B' },
      { navigation: navigation as never, resolveThreadId: async () => null },
    );
    expect(navigation.navigate).toHaveBeenCalledWith('Compose', {
      prefillTo: [{ email: 'a@b.co' }],
      prefillCc: undefined,
      prefillSubject: 'S',
      prefillBody: 'B',
    });
  });

  it('passes Bcc recipients through to the composer', async () => {
    const navigation = nav();
    await handleDeepLink(
      { kind: 'compose', to: [{ email: 'a@b.co' }], cc: [], bcc: [{ email: 'c@d.co' }] },
      { navigation: navigation as never, resolveThreadId: async () => null },
    );
    expect(navigation.navigate).toHaveBeenCalledWith('Compose', expect.objectContaining({
      prefillBcc: [{ email: 'c@d.co' }],
    }));
  });

  it('refuses when the linked account is not signed in', async () => {
    const navigation = nav();
    const ok = await handleDeepLink(
      { kind: 'message', emailId: 'M1', accountId: 'other' },
      { navigation: navigation as never, resolveThreadId: async () => 'T', switchAccount: async () => false },
    );
    expect(ok).toBe(false);
  });
});

describe('shareToDeepLink', () => {
  it('routes shared text into the body and shared addresses into recipients', () => {
    expect(shareToDeepLink({ text: 'hello world', subject: 'S' })).toEqual({
      kind: 'compose', to: [], cc: [], subject: 'S', body: 'hello world',
    });
    expect(shareToDeepLink({ text: 'a@b.co' })).toEqual({
      kind: 'compose', to: [{ email: 'a@b.co' }], cc: [], subject: undefined,
    });
    expect(shareToDeepLink({ text: 'mailto:a@b.co?subject=x' })).toMatchObject({ kind: 'compose', subject: 'x' });
    expect(shareToDeepLink({ text: 'alice+news@partner.example' })).toEqual({
      kind: 'compose', to: [{ email: 'alice+news@partner.example' }], cc: [], subject: undefined,
    });
  });
});
