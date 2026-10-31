// One address on two servers (usera@ on :8120 and on :8016) read the same in
// the global search chips and hit lines and on the add-account screen, and
// "Another account on …" offered only the active account's server.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  accountServerLine,
  ambiguousPushLabel,
  distinctAccountLabels,
  distinctServerUrls,
  pushAccountLabel,
} from '../account-labels';

const a1 = {
  id: 'usera@example.org@10.10.10.62:8120',
  serverUrl: 'http://10.10.10.62:8120',
  username: 'usera@example.org',
  email: 'usera@example.org',
  displayName: 'User A',
};
const a2 = { ...a1, id: 'usera@example.org@10.10.10.62:8016', serverUrl: 'http://10.10.10.62:8016' };
const b = {
  id: 'userb@example.org@mail.example.org',
  serverUrl: 'https://mail.example.org',
  username: 'userb@example.org',
  email: 'userb@example.org',
  displayName: 'User B',
};

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('distinctAccountLabels', () => {
  it('adds the server where two accounts would read the same', () => {
    const labels = distinctAccountLabels([a1, a2, b]);
    expect(labels.get(a1.id)).toBe('usera@example.org (10.10.10.62:8120)');
    expect(labels.get(a2.id)).toBe('usera@example.org (10.10.10.62:8016)');
    expect(labels.get(b.id)).toBe('User B');
  });

  it('leaves a lone account by its name', () => {
    expect(distinctAccountLabels([a1, b]).get(a1.id)).toBe('User A');
  });

  it('falls back to the full URL when two servers only differ in scheme', () => {
    const http = { ...b, id: 'x', serverUrl: 'http://mail.example.org' };
    const labels = distinctAccountLabels([b, http]);
    expect(labels.get(b.id)).toBe('userb@example.org (https://mail.example.org)');
    expect(labels.get('x')).toBe('userb@example.org (http://mail.example.org)');
  });
});

describe('accountServerLine', () => {
  it('names the server when another account has the same address', () => {
    expect(accountServerLine(a1, [a1, a2])).toBe('10.10.10.62:8120');
  });

  it('names a server on a non-default port, as the account settings do', () => {
    expect(accountServerLine(a1, [a1, b])).toBe('10.10.10.62:8120');
  });

  it('leaves it out on a default port with nobody to confuse it with', () => {
    expect(accountServerLine(b, [a1, b])).toBeNull();
  });
});

describe('distinctServerUrls', () => {
  it('offers every server once, the active account first', () => {
    const third = { ...a1, id: 'other@10.10.10.62:8120', serverUrl: 'http://10.10.10.62:8120/' };
    expect(distinctServerUrls([a1, a2, third, b], a2.id)).toEqual([a2.serverUrl, a1.serverUrl, b.serverUrl]);
  });
});

describe('push notification labels', () => {
  const registry = [a1, a2, b];

  it('adds the server to the account a push names when another login has the same username', () => {
    expect(pushAccountLabel(a2.id, 'usera@example.org', registry)).toBe('usera@example.org (10.10.10.62:8016)');
    expect(pushAccountLabel(b.id, 'userb@example.org', registry)).toBe('userb@example.org');
  });

  it('names the servers a push may be from when it fits two logins', () => {
    expect(ambiguousPushLabel([a1.id, a2.id], 'usera@example.org', registry))
      .toBe('usera@example.org (10.10.10.62:8120, 10.10.10.62:8016)');
    expect(ambiguousPushLabel([b.id], 'userb@example.org', registry)).toBe('userb@example.org');
  });
});

describe('where the labels are used', () => {
  it('global search names chips, hits and errors with them', () => {
    const src = read('components/search/GlobalSearchSheet.tsx');
    expect(src).toMatch(/distinctAccountLabels\(accounts\)/);
    expect(src).toMatch(/accountLabelOf\(hit\.localAccountId, hit\.accountLabel\)/);
    expect(src).toMatch(/chip\(a\.id, accountLabelOf\(a\.id,/);
    expect(src).toMatch(/accountLabelOf\(error\.localAccountId, error\.accountLabel\)/);
  });

  it('the add-account screen shows the server line and every known server', () => {
    const choose = read('screens/login/ChooseStep.tsx');
    expect(choose).toMatch(/accountServerLine\(account, accounts\)/);
    expect(choose).toMatch(/knownServerUrls\.map\(/);
    const login = read('screens/LoginScreen.tsx');
    expect(login).toMatch(/distinctServerUrls\(accounts, activeAccountId\)/);
    expect(login).toMatch(/knownServerUrls=\{isAddMode \? addServerUrls : \[\]\}/);
  });
});
