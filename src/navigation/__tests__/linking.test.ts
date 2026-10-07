import { describe, it, expect, vi } from 'vitest';
import { acceptSignInLink, buildCalendarPath, handleDeepLink, parseDeepLink, parseSignInLink, shareToDeepLink } from '../linking';
import { usePendingSignInLinkStore } from '../pending-sign-in-link';
import { usePendingSettingsTab } from '../pending-settings-tab';
import { usePendingCalendarOpen } from '../pending-calendar-open';
import { usePendingMailSearch } from '../pending-mail-search';
import { links } from '../../widgets/clicks';

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
    expect(parseDeepLink('bulwarkmobile://calendar/week/2026-08-29')).toEqual({ kind: 'calendar', view: 'week', date: '2026-08-29' });
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

  it('parses the widget links: reply, draft, unified views, scheduled and search', () => {
    expect(parseDeepLink('bulwarkmobile://mail/message/M1?account=a%40b&jmapAccount=team&action=reply')).toEqual({
      kind: 'message', emailId: 'M1', accountId: 'a@b', jmapAccountId: 'team', action: 'reply',
    });
    // What the widgets build is what the app reads, thread included.
    const m = { id: 'M/1', threadId: 'T1', accountId: 'a@b', jmapAccountId: 'team' };
    expect(parseDeepLink(links.reply(m))).toEqual({
      kind: 'message', emailId: 'M/1', accountId: 'a@b', jmapAccountId: 'team', threadId: 'T1', action: 'reply',
    });
    expect(parseDeepLink(links.message({ id: 'M2', accountId: 'a@b' }))).toEqual({
      kind: 'message', emailId: 'M2', accountId: 'a@b',
    });
    expect(parseDeepLink('bulwarkmobile://mail/draft/D1')).toEqual({ kind: 'draft', emailId: 'D1', accountId: undefined });
    expect(parseDeepLink('bulwarkmobile://mail/unified?view=starred')).toEqual({ kind: 'unified', view: 'starred' });
    expect(parseDeepLink('bulwarkmobile://mail/unified?role=drafts&view=bogus')).toEqual({ kind: 'unified', role: 'drafts' });
    expect(parseDeepLink('bulwarkmobile://mail/scheduled')).toEqual({ kind: 'scheduled' });
    expect(parseDeepLink('bulwarkmobile://mail/search?q=from%3Aada')).toEqual({ kind: 'search', query: 'from:ada' });
    expect(parseDeepLink('bulwarkmobile://mail/search')).toEqual({ kind: 'search', query: '' });
  });

  describe('contact links (the webmail\'s parseContactsPath)', () => {
    it('opens a blank new-contact form for /contacts/new', () => {
      expect(parseDeepLink('https://mail.example.com/contacts/new')).toEqual({ kind: 'contactNew' });
      expect(parseDeepLink('bulwarkmobile://contacts/new')).toEqual({ kind: 'contactNew' });
    });

    it('prefills the new-contact form from ?email= and ?name=', () => {
      expect(parseDeepLink('https://mail.example.com/contacts/new?email=a@b&name=A%20B'))
        .toEqual({ kind: 'contactNew', email: 'a@b', name: 'A B' });
      // The legacy names work on /new too.
      expect(parseDeepLink('https://mail.example.com/contacts/new?addEmail=a@b&addName=A'))
        .toEqual({ kind: 'contactNew', email: 'a@b', name: 'A' });
      expect(parseDeepLink('https://mail.example.com/contacts/new?name=Only%20Name'))
        .toEqual({ kind: 'contactNew', name: 'Only Name' });
    });

    it('reads the legacy ?addEmail= / ?addName= query as a new contact', () => {
      expect(parseDeepLink('https://mail.example.com/contacts?addEmail=a@b&from=email'))
        .toEqual({ kind: 'contactNew', email: 'a@b' });
      expect(parseDeepLink('https://mail.example.com/contacts?addName=Ann'))
        .toEqual({ kind: 'contactNew', name: 'Ann' });
    });

    it('opens the edit form for /contacts/<id>/edit', () => {
      expect(parseDeepLink('https://mail.example.com/contacts/C9/edit')).toEqual({ kind: 'contact', contactId: 'C9', edit: true });
      expect(parseDeepLink('bulwarkmobile://contacts/C%2F9/edit')).toEqual({ kind: 'contact', contactId: 'C/9', edit: true });
      // Any other second segment is just the card.
      expect(parseDeepLink('https://mail.example.com/contacts/C9/other')).toEqual({ kind: 'contact', contactId: 'C9' });
    });

    it('reads the legacy ?contactId=&view=edit query', () => {
      expect(parseDeepLink('https://mail.example.com/contacts?contactId=C9&view=edit'))
        .toEqual({ kind: 'contact', contactId: 'C9', edit: true });
      expect(parseDeepLink('https://mail.example.com/contacts?contactId=C9'))
        .toEqual({ kind: 'contact', contactId: 'C9' });
    });

    it('drops a locale prefix', () => {
      expect(parseDeepLink('https://mail.example.com/de/contacts/C9/edit')).toEqual({ kind: 'contact', contactId: 'C9', edit: true });
      expect(parseDeepLink('https://mail.example.com/pt-BR/contacts/new?email=a@b'))
        .toEqual({ kind: 'contactNew', email: 'a@b' });
    });

    it('carries ?account= as the signed-in account to switch to', () => {
      expect(parseDeepLink('https://mail.example.com/contacts/C9/edit?account=acc'))
        .toEqual({ kind: 'contact', contactId: 'C9', edit: true, accountId: 'acc' });
      expect(parseDeepLink('https://mail.example.com/contacts/new?email=a@b&account=acc'))
        .toEqual({ kind: 'contactNew', email: 'a@b', accountId: 'acc' });
      expect(parseDeepLink('https://mail.example.com/contacts?contactId=C9&account=acc'))
        .toEqual({ kind: 'contact', contactId: 'C9', accountId: 'acc' });
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
    dispatch: vi.fn(),
  });
  const push = (params: object) => ({ type: 'PUSH', payload: { name: 'ContactForm', params } });

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

    // An event link carries no view to show.
    expect(usePendingCalendarOpen.getState().consumeView()).toBeNull();
  });

  it('parses a calendar view and date, tolerating a bad date or view', () => {
    expect(parseDeepLink('bulwarkmobile://calendar/day/2026-08-06')).toEqual({ kind: 'calendar', view: 'day', date: '2026-08-06' });
    expect(parseDeepLink('https://mail.example.com/calendar/agenda')).toEqual({ kind: 'calendar', view: 'agenda' });
    // A bare date keeps whatever view the user has.
    expect(parseDeepLink('bulwarkmobile://calendar/2026-08-06')).toEqual({ kind: 'calendar', date: '2026-08-06' });
    // Impossible or malformed dates are dropped; the view still applies.
    expect(parseDeepLink('bulwarkmobile://calendar/week/2026-02-31')).toEqual({ kind: 'calendar', view: 'week' });
    expect(parseDeepLink('bulwarkmobile://calendar/month/soon')).toEqual({ kind: 'calendar', view: 'month' });
    expect(parseDeepLink('bulwarkmobile://calendar/2026-13-01')).toEqual({ kind: 'calendar' });
    // Webmail's tasks view has no grid here: only the tab opens.
    expect(parseDeepLink('bulwarkmobile://calendar/tasks')).toEqual({ kind: 'calendar' });
    expect(parseDeepLink('bulwarkmobile://calendar/nonsense/2026-08-06')).toEqual({ kind: 'calendar' });
  });

  it('builds calendar paths like the webmail', () => {
    expect(buildCalendarPath({ view: 'week', date: new Date(2026, 7, 6) })).toBe('/calendar/week/2026-08-06');
    expect(buildCalendarPath({ view: 'agenda' })).toBe('/calendar/agenda');
    expect(buildCalendarPath({ view: 'month', eventId: 'a b', accountId: 'acc-2' })).toBe('/calendar/event/a%20b?account=acc-2');
    for (const path of ['/calendar/day/2026-08-06', '/calendar/month']) {
      expect(buildCalendarPath(parseDeepLink(`bulwarkmobile:/${path}`) as never)).toBe(path);
    }
  });

  it('hands a date link to the Calendar tab as a view to show', async () => {
    const navigation = nav();
    const nv = { navigation: navigation as never, resolveThreadId: async () => null };
    await handleDeepLink({ kind: 'calendar', view: 'week', date: '2026-08-29' }, nv);
    expect(usePendingCalendarOpen.getState().consume()).toBeNull();
    expect(usePendingCalendarOpen.getState().consumeView()).toEqual({ view: 'week', date: '2026-08-29' });
    expect(usePendingCalendarOpen.getState().consumeView()).toBeNull();
    expect(navigation.navigate).toHaveBeenCalledWith('MainTabs', { screen: 'Calendar' });
    // The bare tab link parks nothing, and drops a stale view.
    await handleDeepLink({ kind: 'calendar', view: 'day' }, nv);
    await handleDeepLink({ kind: 'calendar' }, nv);
    expect(usePendingCalendarOpen.getState().consumeView()).toBeNull();
  });

  it('switches to the signed-in account a widget event link names first', async () => {
    const navigation = nav();
    const url = links.event({ serverId: 'j', accountId: 'usera@example.org@mail', jmapAccountId: 'd' });
    const link = parseDeepLink(url);
    expect(link).toEqual({ kind: 'calendar', eventId: 'j', jmapAccountId: 'd', accountId: 'usera@example.org@mail' });
    const switchAccount = vi.fn(async () => true);
    await handleDeepLink(link!, { navigation: navigation as never, resolveThreadId: async () => null, switchAccount });
    expect(switchAccount).toHaveBeenCalledWith('usera@example.org@mail');
    expect(usePendingCalendarOpen.getState().consume()).toMatchObject({ serverId: 'j', accountId: 'd' });
    // An account that is no longer signed in opens nothing.
    expect(await handleDeepLink(link!, {
      navigation: navigation as never, resolveThreadId: async () => null, switchAccount: async () => false,
    })).toBe(false);
  });

  it('opens the contact card under its edit form, so Back lands on the card', async () => {
    const navigation = nav();
    expect(await handleDeepLink(
      { kind: 'contact', contactId: 'C9', edit: true },
      { navigation: navigation as never, resolveThreadId: async () => null },
    )).toBe(true);
    expect(navigation.navigate.mock.calls).toEqual([['ContactDetail', { contactId: 'C9' }]]);
    expect(navigation.dispatch.mock.calls).toEqual([[push({ contactId: 'C9' })]]);
    // The card is opened before the form goes over it.
    expect(navigation.navigate.mock.invocationCallOrder[0]).toBeLessThan(navigation.dispatch.mock.invocationCallOrder[0]);
  });

  it('opens just the card for a contact link without /edit', async () => {
    const navigation = nav();
    await handleDeepLink({ kind: 'contact', contactId: 'C9' }, { navigation: navigation as never, resolveThreadId: async () => null });
    expect(navigation.navigate.mock.calls).toEqual([['ContactDetail', { contactId: 'C9' }]]);
    expect(navigation.dispatch).not.toHaveBeenCalled();
  });

  it('opens a new-contact form with the link\'s email and name', async () => {
    const navigation = nav();
    await handleDeepLink(
      { kind: 'contactNew', email: 'a@b', name: 'A B' },
      { navigation: navigation as never, resolveThreadId: async () => null },
    );
    expect(navigation.dispatch).toHaveBeenCalledWith(push({ prefill: { email: 'a@b', name: 'A B' } }));
    const blank = nav();
    await handleDeepLink({ kind: 'contactNew' }, { navigation: blank as never, resolveThreadId: async () => null });
    expect(blank.dispatch).toHaveBeenCalledWith(push({}));
  });

  it('pushes a new form over one already open instead of handing it the new params', async () => {
    // A navigator whose top screen is an edit of C1: NAVIGATE to the same
    // screen name would replace that form's params and keep its values.
    const stack = [{ name: 'ContactForm', params: { contactId: 'C1' } as object }];
    const navigation = {
      isReady: () => true,
      navigate: vi.fn((name: string, params: object) => {
        if (stack[stack.length - 1].name === name) stack[stack.length - 1].params = params;
        else stack.push({ name, params });
      }),
      dispatch: vi.fn((action: { type: string; payload: { name: string; params: object } }) => {
        if (action.type === 'PUSH') stack.push({ name: action.payload.name, params: action.payload.params });
      }),
    };
    await handleDeepLink({ kind: 'contactNew', email: 'a@b' }, { navigation: navigation as never, resolveThreadId: async () => null });
    expect(stack).toEqual([
      { name: 'ContactForm', params: { contactId: 'C1' } },
      { name: 'ContactForm', params: { prefill: { email: 'a@b' } } },
    ]);
    await handleDeepLink({ kind: 'contact', contactId: 'C9', edit: true }, { navigation: navigation as never, resolveThreadId: async () => null });
    expect(stack.slice(2)).toEqual([
      { name: 'ContactDetail', params: { contactId: 'C9' } },
      { name: 'ContactForm', params: { contactId: 'C9' } },
    ]);
  });

  it('switches to a contact link\'s account first, and opens nothing when it is not signed in', async () => {
    const navigation = nav();
    const switchAccount = vi.fn(async () => true);
    await handleDeepLink(
      { kind: 'contact', contactId: 'C9', edit: true, accountId: 'acc' },
      { navigation: navigation as never, resolveThreadId: async () => null, switchAccount },
    );
    expect(switchAccount).toHaveBeenCalledWith('acc');
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.dispatch).toHaveBeenCalledTimes(1);

    const refused = nav();
    for (const link of [
      { kind: 'contact' as const, contactId: 'C9', edit: true, accountId: 'gone' },
      { kind: 'contactNew' as const, email: 'a@b', accountId: 'gone' },
    ]) {
      expect(await handleDeepLink(link, {
        navigation: refused as never, resolveThreadId: async () => null, switchAccount: async () => false,
      })).toBe(false);
    }
    expect(refused.navigate).not.toHaveBeenCalled();
    expect(refused.dispatch).not.toHaveBeenCalled();
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

  it('opens a group-mailbox message in its JMAP account', async () => {
    const navigation = nav();
    const resolveThreadId = vi.fn(async () => 'T1');
    await handleDeepLink(
      { kind: 'message', emailId: 'M1', jmapAccountId: 'team' },
      { navigation: navigation as never, resolveThreadId },
    );
    expect(resolveThreadId).toHaveBeenCalledWith('M1', 'team');
    expect(navigation.navigate).toHaveBeenCalledWith('EmailThread', { emailId: 'M1', threadId: 'T1', jmapAccountId: 'team' });
  });

  it('opens a reply over its message, without a lookup when the link names the thread', async () => {
    // Offline, or before the session is back: the lookup would fail.
    const resolveThreadId = vi.fn(async () => null);
    const navigation = nav();
    const ok = await handleDeepLink(
      { kind: 'message', emailId: 'M2', threadId: 'T2', action: 'reply' },
      { navigation: navigation as never, resolveThreadId },
    );
    expect(ok).toBe(true);
    expect(resolveThreadId).not.toHaveBeenCalled();
    expect(navigation.navigate).toHaveBeenCalledWith('EmailThread', { emailId: 'M2', threadId: 'T2', action: 'reply' });

    // Without the thread and without a server, nothing opens (the app says so).
    expect(await handleDeepLink(
      { kind: 'message', emailId: 'M3', action: 'reply' },
      { navigation: nav() as never, resolveThreadId },
    )).toBe(false);
  });

  it('opens drafts, unified views, scheduled mail and searches', async () => {
    const openDraft = vi.fn(async () => true);
    const navigation = nav();
    const deps = { navigation: navigation as never, resolveThreadId: async () => 'T', openDraft };
    expect(await handleDeepLink({ kind: 'draft', emailId: 'D1' }, deps)).toBe(true);
    expect(openDraft).toHaveBeenCalledWith('D1', undefined);
    await handleDeepLink({ kind: 'unified', view: 'starred' }, deps);
    expect(navigation.navigate).toHaveBeenCalledWith('UnifiedInbox', { view: 'starred' });
    await handleDeepLink({ kind: 'scheduled' }, deps);
    expect(navigation.navigate).toHaveBeenCalledWith('Scheduled');
    await handleDeepLink({ kind: 'search', query: 'from:ada' }, deps);
    expect(usePendingMailSearch.getState().consume()).toBe('from:ada');
    expect(navigation.navigate).toHaveBeenCalledWith('MainTabs', { screen: 'Mail' });
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

describe('sign-in links', () => {
  const code = 'c0ffee'.repeat(10) + 'beef';
  const pair = `bulwarkmail://pair?server=${encodeURIComponent('https://mail.example.com/webmail')}&code=${code}`;

  it('are never navigation links', () => {
    expect(parseDeepLink(pair)).toBeNull();
    expect(parseDeepLink('bulwarkmail://connect?server=https%3A%2F%2Fmail.example.com')).toBeNull();
    // The scheme is not an alias of the app scheme.
    expect(parseDeepLink('bulwarkmail://mail/message/M1')).toBeNull();
  });

  it('parses pair and connect links, and nothing else', () => {
    expect(parseSignInLink(pair)).toEqual({ kind: 'pair', webmailUrl: 'https://mail.example.com/webmail', code });
    expect(parseSignInLink(pair.replace('://pair?', '://pair/?'))).toEqual({
      kind: 'pair', webmailUrl: 'https://mail.example.com/webmail', code,
    });
    expect(parseSignInLink('bulwarkmail://connect?server=https%3A%2F%2Fmail.example.com'))
      .toEqual({ kind: 'connect', webmailUrl: 'https://mail.example.com' });
    // A plain webmail address is a QR convenience, not a link that signs in.
    expect(parseSignInLink('https://mail.example.com')).toBeNull();
    expect(parseSignInLink('bulwarkmobile://mail/message/M1')).toBeNull();
    expect(parseSignInLink(`bulwarkmail://pair?server=http%3A%2F%2Fmail.example.com&code=${code}`)).toBeNull();
    expect(parseSignInLink(null)).toBeNull();
  });

  it('parks a sign-in link from the OS as external, for the login screen to take once', () => {
    usePendingSignInLinkStore.getState().clear();
    expect(acceptSignInLink('bulwarkmobile://mail')).toBe(false);
    expect(acceptSignInLink('mailto:a@b.co')).toBe(false);
    expect(usePendingSignInLinkStore.getState().pending).toBeNull();

    expect(acceptSignInLink(pair)).toBe(true);
    expect(usePendingSignInLinkStore.getState().pending).toMatchObject({
      source: 'external',
      payload: { kind: 'pair', webmailUrl: 'https://mail.example.com/webmail', code },
    });
    // Anyone can fire the link, so it is not run until the user confirms.
    expect(usePendingSignInLinkStore.getState().take()).toMatchObject({
      needsConfirmation: true,
      payload: { kind: 'pair', webmailUrl: 'https://mail.example.com/webmail', code },
    });
    // Taken means cleared: a second delivery of the same state signs in nothing.
    expect(usePendingSignInLinkStore.getState().pending).toBeNull();
    expect(usePendingSignInLinkStore.getState().take()).toBeNull();
    usePendingSignInLinkStore.getState().clear();
  });

  it('parks connect links as external too', () => {
    usePendingSignInLinkStore.getState().clear();
    expect(acceptSignInLink('bulwarkmail://connect?server=https%3A%2F%2Fmail.example.com')).toBe(true);
    expect(usePendingSignInLinkStore.getState().take()).toMatchObject({
      needsConfirmation: true,
      payload: { kind: 'connect', webmailUrl: 'https://mail.example.com' },
    });
    usePendingSignInLinkStore.getState().clear();
  });
});
