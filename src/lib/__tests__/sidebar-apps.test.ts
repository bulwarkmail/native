import { describe, it, expect, vi, beforeEach } from 'vitest';

const openBrowserAsync = vi.hoisted(() => vi.fn(async (_url: string) => ({ type: 'opened' })));
vi.mock('expo-web-browser', () => ({ openBrowserAsync, maybeCompleteAuthSession: vi.fn() }));

import {
  sanitizeSidebarAppUrl, selectMobileSidebarApps, openSidebarApp,
} from '../sidebar-apps';
import type { SidebarApp } from '../../stores/settings-store';

const app = (over: Partial<SidebarApp> = {}): SidebarApp => ({
  id: 'a', name: 'Wiki', url: 'https://wiki.example.com/', icon: 'Globe',
  openMode: 'tab', showOnMobile: true, ...over,
});

describe('sanitizeSidebarAppUrl', () => {
  it('accepts https', () => {
    expect(sanitizeSidebarAppUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(sanitizeSidebarAppUrl('HTTPS://example.com/')).toBe('https://example.com/');
  });

  it.each([
    'http://example.com',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'intent://x#Intent;scheme=https;end',
    'INTENT://x',
    'file:///etc/passwd',
    'FiLe:///etc/passwd',
    'content://com.android.contacts/contacts',
    'Content://x',
    'data:text/html,<b>x</b>',
    'DaTa:text/html,x',
    'mailto:a@b.c',
    '//example.com',
    'example.com',
    'https://',
  ])('rejects %s', (u) => {
    expect(sanitizeSidebarAppUrl(u)).toBeNull();
  });

  it.each([
    ' https://example.com',
    'https://example.com ',
    '\thttps://example.com',
    'https://example.com\n',
    '\u0000https://example.com',
    'https://exa\u0000mple.com',
    'https://example.com/\u0007',
    'https://example.com/\u007f',
    'https://exa mple.com',
    '\u00a0https://example.com',
    '\u200bhttps://example.com',
    'java\nscript:alert(1)',
  ])('rejects whitespace and control characters in %j', (u) => {
    expect(sanitizeSidebarAppUrl(u)).toBeNull();
  });

  it.each([
    'https://user:pass@example.com/',
    'https://user@example.com/',
    'https://:pass@example.com/',
  ])('rejects embedded credentials in %s', (u) => {
    expect(sanitizeSidebarAppUrl(u)).toBeNull();
  });

  it('rejects non-strings and over-long values', () => {
    expect(sanitizeSidebarAppUrl(undefined)).toBeNull();
    expect(sanitizeSidebarAppUrl(42)).toBeNull();
    expect(sanitizeSidebarAppUrl('')).toBeNull();
    expect(sanitizeSidebarAppUrl('https://example.com/' + 'a'.repeat(2048))).toBeNull();
  });
});

describe('selectMobileSidebarApps', () => {
  it('builds the list from settings, in order, mobile-visible only', () => {
    const apps = [
      app({ id: '1', name: 'One' }),
      app({ id: '2', name: 'Hidden', showOnMobile: false }),
      app({ id: '3', name: 'Three', url: 'https://three.example.com' }),
    ];
    expect(selectMobileSidebarApps(apps).map((a) => a.id)).toEqual(['1', '3']);
  });

  it('hides saved entries with an unsafe url and normalizes the rest', () => {
    const apps = [
      app({ id: 'js', url: 'javascript:alert(1)' }),
      app({ id: 'http', url: 'http://example.com' }),
      app({ id: 'cred', url: 'https://u:p@example.com' }),
      app({ id: 'ws', url: ' https://example.com' }),
      app({ id: 'ok', url: 'HTTPS://example.com' }),
    ];
    const out = selectMobileSidebarApps(apps);
    expect(out.map((a) => a.id)).toEqual(['ok']);
    expect(out[0].url).toBe('https://example.com/');
  });
});

describe('openSidebarApp', () => {
  beforeEach(() => openBrowserAsync.mockClear());

  it('opens a valid app in a Custom Tab, whatever its open mode', async () => {
    await openSidebarApp(app({ openMode: 'inline' }));
    await openSidebarApp(app({ openMode: 'tab', url: 'https://b.example.com' }));
    expect(openBrowserAsync.mock.calls.map((c) => c[0])).toEqual([
      'https://wiki.example.com/', 'https://b.example.com/',
    ]);
  });

  it.each([
    'javascript:alert(1)', 'JavaScript:alert(1)', 'intent://x', 'file:///x',
    'content://x', 'data:text/html,x', ' https://example.com',
    'https://u:p@example.com', 'http://example.com',
  ])('refuses a stored %s without opening anything', async (url) => {
    await openSidebarApp(app({ url }));
    expect(openBrowserAsync).not.toHaveBeenCalled();
  });
});
