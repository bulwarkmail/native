import { describe, it, expect } from 'vitest';
import {
  findMeetingLink,
  isMeetingLabel,
  locationAction,
  mapsUrl,
  meetingProviderOf,
  primaryLocationName,
  unwrapSafeLink,
} from '../event-links';

/**
 * A Teams invitation fills LOCATION with "Microsoft Teams Meeting" and leaves
 * the join URL in the description, next to help and dial-in links. The popover
 * must still offer the join link, and a real address must open the maps.
 */

const TEAMS_JOIN = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjQ5%40thread.v2/0?context=%7b%22Tid%22%3a%22abc%22%7d';

const TEAMS_DESCRIPTION = [
  '________________________________________________________________________________',
  'Réunion Microsoft Teams',
  'Rejoindre sur votre ordinateur, application mobile ou appareil de salle',
  `Cliquez ici pour participer à la réunion<${TEAMS_JOIN}>`,
  'ID de la réunion : 319 560 123 45',
  'Code secret : CTYa9',
  'Télécharger Teams<https://www.microsoft.com/fr-fr/microsoft-teams/download-app> | Rejoindre sur le web<https://www.microsoft.com/microsoft-teams/join-a-meeting>',
  'En savoir plus<https://aka.ms/JoinTeamsMeeting> | Options de réunion<https://teams.microsoft.com/meetingOptions/?organizerId=1>',
].join('\n');

describe('findMeetingLink', () => {
  it('prefers the structured virtual location', () => {
    expect(findMeetingLink({
      virtualLocations: { v: { uri: 'https://zoom.us/j/123' } },
      description: TEAMS_DESCRIPTION,
    })).toEqual({ uri: 'https://zoom.us/j/123', provider: 'Zoom', derived: false });
  });

  it('digs the Teams join URL out of the description, skipping help links', () => {
    expect(findMeetingLink({
      locations: { l: { name: 'Réunion Microsoft Teams' } },
      description: TEAMS_DESCRIPTION,
    })).toEqual({ uri: TEAMS_JOIN, provider: 'Teams', derived: true });
  });

  it('recognises the short Teams, Meet and Zoom forms', () => {
    expect(findMeetingLink({ description: 'Join: https://teams.microsoft.com/meet/31956012345?p=CTYa9' })?.provider).toBe('Teams');
    expect(findMeetingLink({ description: 'Meet: https://meet.google.com/abc-defg-hij.' })?.uri).toBe('https://meet.google.com/abc-defg-hij');
    expect(findMeetingLink({ description: 'https://us02web.zoom.us/j/8812345?pwd=xyz' })?.provider).toBe('Zoom');
  });

  it('takes a meeting URL used as the location', () => {
    expect(findMeetingLink({ locations: { l: { name: 'https://meet.jit.si/standup' } } })?.uri).toBe('https://meet.jit.si/standup');
  });

  it('unwraps Outlook Safe Links', () => {
    const wrapped = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(TEAMS_JOIN)}&data=05`;
    expect(findMeetingLink({ description: `Join<${wrapped}>` })?.uri).toBe(TEAMS_JOIN);
  });

  it('ignores ordinary links', () => {
    expect(findMeetingLink({ description: 'Agenda: https://docs.example.com/agenda https://aka.ms/JoinTeamsMeeting' })).toBeNull();
    expect(findMeetingLink({})).toBeNull();
  });

  it('falls back to a virtual location the app may open, never a script or app-deep-link one', () => {
    expect(findMeetingLink({ virtualLocations: { v: { uri: 'tel:+33123456789' } } }))
      .toEqual({ uri: 'tel:+33123456789', derived: false });
    for (const uri of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'intent://x#Intent;end', 'msteams:/l/meetup-join/19%3a1', 'vbscript:x']) {
      expect(findMeetingLink({ virtualLocations: { v: { uri } } })).toBeNull();
    }
  });

  it('never returns an unsafe URL found in the text', () => {
    expect(findMeetingLink({ description: 'javascript:alert(1) data:text/html,x file:///etc/passwd' })).toBeNull();
  });

  it('recognises the Zoom web-client join path', () => {
    expect(findMeetingLink({ description: 'https://acme.zoom.us/wc/join/8812345?pwd=x' })?.provider).toBe('Zoom');
  });

  it('skips a virtual location that is not a web URL', () => {
    expect(findMeetingLink({
      virtualLocations: { v: { uri: 'tel:+33123456789' } },
      description: 'https://meet.google.com/abc-defg-hij',
    })?.provider).toBe('Google Meet');
  });
});

describe('meetingProviderOf / unwrapSafeLink', () => {
  it('rejects look-alike hosts', () => {
    expect(meetingProviderOf('https://teams.microsoft.com.evil.example/l/meetup-join/x')).toBeNull();
    expect(meetingProviderOf('https://notzoom.us/j/1')).toBeNull();
  });

  it('leaves non-wrapped URLs alone', () => {
    expect(unwrapSafeLink('https://example.com/?url=https://x.y')).toBe('https://example.com/?url=https://x.y');
  });
});

describe('unwrapSafeLink safety', () => {
  it('does not unwrap to a non-http(s) target', () => {
    for (const inner of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'intent://x#Intent;end']) {
      const wrapped = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(inner)}&data=05`;
      expect(unwrapSafeLink(wrapped)).toBe(wrapped);
      expect(findMeetingLink({ description: wrapped })).toBeNull();
    }
  });
  it('does not unwrap to a URL with control characters', () => {
    const wrapped = `https://x.safelinks.protection.outlook.com/?url=${encodeURIComponent('https://zoom.us/j/1\u0007x')}`;
    expect(unwrapSafeLink(wrapped)).toBe(wrapped);
  });
});

describe('locationAction', () => {
  const meeting = { uri: TEAMS_JOIN, provider: 'Teams', derived: true };

  it('searches the maps for a postal address', () => {
    expect(locationAction('12 rue de la Paix, 75002 Paris', meeting)).toEqual({ kind: 'maps', query: '12 rue de la Paix, 75002 Paris' });
  });

  it('joins the meeting when the location only names the service', () => {
    expect(locationAction('Réunion Microsoft Teams', meeting)).toEqual({ kind: 'url', uri: TEAMS_JOIN });
    expect(locationAction('Microsoft Teams Meeting', null)).toEqual({ kind: 'maps', query: 'Microsoft Teams Meeting' });
  });

  it('opens a URL location', () => {
    expect(locationAction(' https://example.com/room ', null)).toEqual({ kind: 'url', uri: 'https://example.com/room' });
  });

  it('only treats a bare service name as a meeting', () => {
    for (const label of ['Zoom', 'Réunion Microsoft Teams', 'Microsoft Teams Meeting', 'Google Meet', 'En ligne', 'Visioconférence']) {
      expect(isMeetingLabel(label)).toBe(true);
    }
    for (const label of ['Salle Teams 3', 'Salle Teams', 'Studio Zoom', 'Salle Visio', 'Café en ligne droite, Paris']) {
      expect(isMeetingLabel(label)).toBe(false);
    }
  });
});

describe('mapsUrl', () => {
  it('builds a Google Maps search, collapsing line breaks', () => {
    expect(mapsUrl('12 rue de la Paix,\n75002 Paris')).toBe('https://www.google.com/maps/search/?api=1&query=12%20rue%20de%20la%20Paix%2C%2075002%20Paris');
  });
});

describe('mapsUrl hostile locations', () => {
  const hostile = ['javascript:alert(1)', 'a?b=c#d&e=f', 'https://evil.example/x', '//evil.example', '\\evil.example', 'x"><script>', 'a\u0000b'];
  it('keeps scheme, host and path fixed whatever the location says', () => {
    for (const q of hostile) {
      const u = new URL(mapsUrl(q));
      expect(u.protocol).toBe('https:');
      expect(u.host).toBe('www.google.com');
      expect(u.pathname).toBe('/maps/search/');
      expect(u.hash).toBe('');
      expect([...u.searchParams.keys()]).toEqual(['api', 'query']);
      expect(u.searchParams.get('query')).toBe(q.replace(/\s+/g, ' ').trim());
    }
  });
  it('treats a script location as a maps query', () => {
    expect(locationAction('javascript:alert(1)', null)).toEqual({ kind: 'maps', query: 'javascript:alert(1)' });
  });
});

describe('linear time on hostile text', () => {
  const big = (unit: string) => unit.repeat(Math.ceil(200_000 / unit.length));
  const shapes = ['https://', 'http://a.', 'https://zoom.us/j/', ')', 'https://a' + ')'.repeat(50) + 'x ', '<https://a.', 'a. '];
  it.each(shapes)('findMeetingLink stays fast on %s repeated', (unit) => {
    const text = big(unit);
    const start = performance.now();
    findMeetingLink({ description: text, locations: { l: { name: text, description: text } } });
    expect(performance.now() - start).toBeLessThan(500);
  });
  it('isMeetingLabel / locationAction / mapsUrl stay fast on a huge location', () => {
    const text = big('é a-');
    const start = performance.now();
    isMeetingLabel(text);
    locationAction(text, null);
    mapsUrl(text);
    expect(performance.now() - start).toBeLessThan(500);
  });
  it('still finds a meeting link within the scanned window of a large description', () => {
    expect(findMeetingLink({ description: `Join https://meet.google.com/abc-defg-hij ${big('x ')}` })?.provider).toBe('Google Meet');
  });
});

describe('primaryLocationName', () => {
  it('trims and drops blank names', () => {
    expect(primaryLocationName({ locations: { a: { name: '  ' } } })).toBeUndefined();
    expect(primaryLocationName({ locations: { a: { name: ' Lyon ' } } })).toBe('Lyon');
  });
});
