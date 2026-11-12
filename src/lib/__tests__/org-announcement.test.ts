import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  announcementParts,
  announcementText,
  nextAnnouncementChange,
  useAnnouncementDismissals,
  visibleAnnouncement,
  type Announcement,
} from '../org-announcement';
import { organisationFor } from '../org-organisation';
import { sanitizePolicy } from '../org-policy';

// The organisation announcement (webmail lib/org-announcement.ts,
// components/org/org-announcement.tsx).

const base: Announcement = {
  id: 'maint', severity: 'warning', text: { en: 'Maintenance tonight', de: 'Wartung heute Nacht', 'pt-BR': 'Manutenção' },
  fallbackLocale: 'de', startsAt: '2026-11-12T10:00:00.000Z', endsAt: '2026-11-13T10:00:00.000Z', dismissible: true,
};
const NOW = Date.parse('2026-11-12T12:00:00Z');

beforeEach(async () => {
  await AsyncStorage.clear();
  useAnnouncementDismissals.setState({ byAccount: {}, hydrated: true });
});

describe('announcement text', () => {
  it('picks the locale, then its language, then the fallback locale', () => {
    expect(announcementText(base, 'de-AT')).toBe('Wartung heute Nacht');
    expect(announcementText(base, 'pt')).toBe('Manutenção');
    expect(announcementText(base, 'fr')).toBe('Wartung heute Nacht');
    expect(announcementText({ ...base, text: {} }, 'en')).toBe('');
  });

  it('splits links out of the text, keeping a full stop after one', () => {
    expect(announcementParts('See https://status.example.org. Thanks')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', href: 'https://status.example.org' },
      { kind: 'text', text: '. Thanks' },
    ]);
  });
});

describe('visibleAnnouncement', () => {
  const opts = { locale: 'en', now: NOW, accountId: 'a1', dismissed: {} as Record<string, string> };

  it('shows only inside its start and end time', () => {
    expect(visibleAnnouncement(base, opts)?.text).toBe('Maintenance tonight');
    expect(visibleAnnouncement(base, { ...opts, now: Date.parse('2026-11-12T09:00:00Z') })).toBeNull();
    expect(visibleAnnouncement(base, { ...opts, now: Date.parse('2026-11-13T10:00:00Z') })).toBeNull();
    expect(nextAnnouncementChange(base, NOW)).toBe(Date.parse(base.endsAt));
  });

  it('remembers a close per account and announcement, and shows an edited one again', () => {
    useAnnouncementDismissals.getState().dismiss(base, 'a1');
    const dismissed = useAnnouncementDismissals.getState().byAccount;
    expect(visibleAnnouncement(base, { ...opts, dismissed })).toBeNull();
    expect(visibleAnnouncement(base, { ...opts, dismissed, accountId: 'a2' })).not.toBeNull();
    expect(visibleAnnouncement({ ...base, text: { en: 'Moved to Friday' } }, { ...opts, dismissed })).not.toBeNull();
    // One that can't be closed stays.
    expect(visibleAnnouncement({ ...base, dismissible: false }, { ...opts, dismissed })).not.toBeNull();
  });

  it('keeps a close across starts', async () => {
    useAnnouncementDismissals.getState().dismiss(base, 'a1');
    await new Promise((r) => setTimeout(r, 0));
    useAnnouncementDismissals.setState({ byAccount: {}, hydrated: false });
    await useAnnouncementDismissals.getState().hydrate();
    expect(visibleAnnouncement(base, { ...opts, dismissed: useAnnouncementDismissals.getState().byAccount })).toBeNull();
  });

  it('reads the announcement from the policy, which a scope replaces as a whole', () => {
    const policy = sanitizePolicy({ organisation: { announcement: { ...base, startsAt: '', endsAt: '' } } })!;
    expect(visibleAnnouncement(organisationFor(policy, null).announcement, opts)?.text).toBe('Maintenance tonight');
    expect(visibleAnnouncement(organisationFor(sanitizePolicy({ organisation: { announcement: { id: 'x', text: { en: '  ' } } } })!, null).announcement, opts)).toBeNull();
  });
});

describe('banner placement', () => {
  it('sits under the header of Mail, Calendar, Contacts, Files and Settings', () => {
    for (const screen of ['EmailListScreen', 'CalendarScreen', 'ContactsScreen', 'FilesScreen', 'SettingsScreen']) {
      const source = readFileSync(join(__dirname, '../../screens', `${screen}.tsx`), 'utf8');
      expect(source, screen).toMatch(/<OrgAnnouncementBanner \/>/);
    }
  });
});
