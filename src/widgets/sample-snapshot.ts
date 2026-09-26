// Demo data with something in every section: the same people, mail and
// events as the webmail's demo mode. The widget picker previews
// (src/widgets/previews/*.png) show it at PREVIEW_NOW, so they never contain
// anyone's real mail, and the layout tests draw every widget from it. Times
// are relative to `now`.

import { generateEmailAvatarColor, getEmailInitials } from '../lib/avatar-utils';
import { addDays, startOfDay } from './format';
import { emptySnapshot, type EventItem, type MailItem, type WidgetSnapshot } from './snapshot';
import { normalizeHex } from './theme';

/** The moment the previews show: a Tuesday morning, ahead of the standup. */
export const PREVIEW_NOW = new Date(2026, 8, 22, 9, 35).getTime();

const WORK = '#22c55e';
const PERSONAL = '#3b82f6';

function person(name: string, email: string) {
  return {
    initials: getEmailInitials(name, email),
    color: normalizeHex(generateEmailAvatarColor(name, email)),
  };
}

function mail(
  id: string,
  fromName: string,
  fromEmail: string,
  subject: string,
  preview: string,
  receivedAt: number,
  extra: Partial<MailItem> = {},
): MailItem {
  return {
    id,
    threadId: `t-${id}`,
    accountId: 'demo@example.com@demo',
    fromName,
    fromEmail,
    ...person(fromName, fromEmail),
    subject,
    preview,
    receivedAt,
    unread: true,
    starred: false,
    hasAttachment: false,
    threadSize: 1,
    ...extra,
  };
}

function event(id: string, title: string, start: number, minutes: number, extra: Partial<EventItem> = {}): EventItem {
  return {
    id,
    serverId: id,
    title,
    start,
    end: start + minutes * 60000,
    allDay: false,
    color: WORK,
    calendarName: 'Work',
    participants: [],
    ...extra,
  };
}

export function sampleSnapshot(now: number): WidgetSnapshot {
  const today = startOfDay(now);
  const at = (days: number, h: number, m = 0) => addDays(today, days) + (h * 60 + m) * 60000;
  const ago = (minutes: number) => now - minutes * 60000;

  const inbox: MailItem[] = [
    mail('m1', 'Sofia Russo', 'sofia.russo@example.com', 'when are you coming home?',
      'Hi sweetie, your father and I were just talking - we miss you.', ago(25), { threadSize: 2 }),
    mail('m2', 'Sarah Kim', 'sarah.kim@example.com', 'Invoice #2024-089 & landing-page prototype v3',
      'Hi, please find attached the invoice for October and a screenshot', ago(46), { hasAttachment: true }),
    mail('m3', 'Alice Johnson', 'alice.johnson@example.com', 'Re: Q4 Project Timeline',
      'Works for me. Bob, can you confirm the freeze date?', ago(79), { threadSize: 3 }),
    mail('m4', 'Marcus Hughes', 'marcus.hughes@example.com', 'book club thursday - picking the next one',
      'Three candidates so far, vote by Wednesday', ago(97)),
    mail('m5', "Dr. Smith's Office", 'appointments@drsmith.example', 'Appointment reminder - Tuesday at 10:00',
      'This is a friendly reminder of your upcoming cleaning appointment', ago(60 * 26), { unread: false, starred: true }),
    mail('m6', 'Carlos Rivera', 'carlos.rivera@example.com', 'Friday dinner - moved to 7:30 (sorry!)',
      'Same place, just a bit later', ago(60 * 50), { unread: false, starred: true }),
  ];

  const standup = event('e1', 'Weekly Standup', at(0, 10), 30, {
    videoUrl: 'https://zoom.example/j/123456',
    videoName: 'Zoom',
    participants: [
      { name: 'Alice Johnson', email: 'alice.johnson@example.com', ...person('Alice Johnson', 'alice.johnson@example.com') },
      { name: 'Bob Chen', email: 'bob.chen@example.com', ...person('Bob Chen', 'bob.chen@example.com') },
    ],
  });
  const events: EventItem[] = [
    standup,
    event('e2', 'Lunch Meeting with Sarah', at(0, 12, 30), 60, {
      location: 'The Garden Bistro',
    }),
    event('e3', 'Dentist Appointment', at(1, 10), 60, {
      color: PERSONAL, calendarName: 'Personal', location: 'Dr. Smith Dental Clinic',
    }),
    event('e4', 'Quarterly Review', at(2, 14), 120),
    event('e5', 'Birthday Party', at(3, 0), 24 * 60, { allDay: true, color: PERSONAL, calendarName: 'Personal' }),
    event('e6', 'Weekend Trip', at(4, 0), 2 * 24 * 60, { allDay: true, color: PERSONAL, calendarName: 'Personal' }),
    event('e7', 'Design review', at(-1, 15), 60),
    event('e8', 'Sprint planning', at(-1, 11), 90),
    event('e9', '1:1 with Alice', at(1, 15, 30), 30),
    event('e10', 'Team retro', at(3, 11), 60),
  ];

  const base = emptySnapshot();
  return {
    ...base,
    generatedAt: now,
    appDataAt: now,
    signedIn: true,
    theme: 'light',
    locale: 'en',
    hour12: false,
    weekStart: 1,
    accounts: [
      { id: 'demo@example.com@demo', label: 'Work', color: '#2563eb', unread: 6 },
      { id: 'demo@home.example@demo', label: 'Personal', color: '#db2777', unread: 4 },
    ],
    activeAccountId: 'demo@example.com@demo',
    mail: {
      ...base.mail,
      folders: [
        { role: 'inbox', name: 'Inbox', unread: 10, total: 23 },
        { role: 'drafts', name: 'Drafts', unread: 0, total: 2 },
        { role: 'junk', name: 'Spam', unread: 3, total: 3 },
        { role: 'archive', name: 'Archive', unread: 0, total: 120 },
      ],
      inbox,
      unified: [
        inbox[0],
        { ...inbox[1], accountId: 'demo@home.example@demo' },
        inbox[2],
        inbox[3],
      ],
      starred: inbox.filter((m) => m.starred),
      starredCount: 3,
      drafts: [mail('d1', 'Demo User', 'demo@example.com', 'Meeting Notes - Draft', 'Here are the notes from today', ago(20), { unread: false })],
      draftCount: 2,
      scheduled: [
        { id: 's1', to: 'Alice Johnson', subject: 'Updated Requirements Document', sendAt: at(1, 8) },
        { id: 's2', to: 'Sarah Kim', subject: 'Re: Invoice #2024-089', sendAt: at(4, 17) },
      ],
      pendingChanges: 0,
      favourites: [
        { name: 'Sofia Russo', email: 'sofia.russo@example.com', ...person('Sofia Russo', 'sofia.russo@example.com'), unread: 2, lastAt: ago(25) },
        { name: 'Alice Johnson', email: 'alice.johnson@example.com', ...person('Alice Johnson', 'alice.johnson@example.com'), unread: 1, lastAt: ago(79) },
        { name: 'Sarah Kim', email: 'sarah.kim@example.com', ...person('Sarah Kim', 'sarah.kim@example.com'), unread: 0, lastAt: ago(60 * 30) },
        { name: 'Carlos Rivera', email: 'carlos.rivera@example.com', ...person('Carlos Rivera', 'carlos.rivera@example.com'), unread: 0, lastAt: ago(60 * 50) },
      ],
      recentSearches: ['from:sarah', 'invoice', 'has:attachment', 'Q4 timeline', 'is:unread'],
      tags: [{ keyword: '$label:receipts', name: 'Receipts', color: '#f97316', unread: 2, total: 14, latestFrom: 'Sarah Kim', latestAt: ago(46) }],
      attachments: [
        { emailId: 'm2', accountId: 'demo@example.com@demo', fromName: 'Sarah Kim', receivedAt: ago(46),
          files: [{ name: 'Invoice-2024-089.pdf', type: 'application/pdf' }, { name: 'prototype-v3.png', type: 'image/png' }] },
        { emailId: 'm7', accountId: 'demo@example.com@demo', fromName: 'Anna Kowalski', receivedAt: ago(60 * 48),
          files: [{ name: 'wedding-001.jpg', type: 'image/jpeg' }, { name: 'wedding-014.jpg', type: 'image/jpeg' }, { name: 'wedding-038.jpg', type: 'image/jpeg' }] },
      ],
    },
    calendar: {
      supported: true,
      events,
      invitations: [{
        ...event('e4', 'Quarterly Review', at(2, 14), 120, {
          organizerName: 'Alice Johnson',
          participants: [
            { name: 'Alice Johnson', email: 'alice.johnson@example.com', ...person('Alice Johnson', 'alice.johnson@example.com') },
            { name: 'Bob Chen', email: 'bob.chen@example.com', ...person('Bob Chen', 'bob.chen@example.com') },
          ],
          myStatus: 'needs-action',
        }),
        participantId: 'me',
      }],
      birthdays: [
        { name: 'Alice Johnson', email: 'alice.johnson@example.com', ...person('Alice Johnson', 'alice.johnson@example.com'), date: addDays(today, 10) },
        { name: 'Carlos Rivera', email: 'carlos.rivera@example.com', ...person('Carlos Rivera', 'carlos.rivera@example.com'), date: addDays(today, 24) },
      ],
    },
    tasks: {
      supported: true,
      items: [
        { id: 'k1', serverId: 'k1', title: 'Pay electricity bill', due: addDays(today, -2), dueHasTime: false, done: false, calendarName: 'Personal', color: PERSONAL },
        { id: 'k2', serverId: 'k2', title: 'Buy groceries', due: today, dueHasTime: false, done: false, calendarName: 'Personal', color: PERSONAL },
        { id: 'k3', serverId: 'k3', title: 'Prepare quarterly report', due: addDays(today, 1), dueHasTime: false, done: false, calendarName: 'Work', color: WORK },
        { id: 'k4', serverId: 'k4', title: 'Schedule dentist appointment', due: addDays(today, 3), dueHasTime: false, done: false, calendarName: 'Personal', color: PERSONAL },
        { id: 'k5', serverId: 'k5', title: 'Review pull requests', due: today, dueHasTime: false, done: true, calendarName: 'Work', color: WORK },
      ],
    },
    files: {
      supported: true,
      items: [
        { id: 'f1', name: 'budget.xlsx', isFolder: false, size: 67 * 1024, modified: ago(60 * 24), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { id: 'f2', name: 'Documents', isFolder: true, size: 0, modified: ago(60 * 48), type: '' },
        { id: 'f3', name: 'product-launch.pptx', isFolder: false, size: 500 * 1024, modified: ago(60 * 72), type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
      ],
    },
    vacation: { enabled: true, to: addDays(today, 7), subject: 'Out of Office' },
    quota: { used: 1.15 * 1024 ** 3, limit: 5 * 1024 ** 3 },
  };
}
