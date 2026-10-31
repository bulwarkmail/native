import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { deviceSyncAccountLabel } from '../account-label';

const account = (id: string, email: string, serverUrl: string) => ({ id, email, username: email, serverUrl });

describe('the account name in Sync to this device', () => {
  const a = account('usera@10.10.10.62:8016', 'usera@example.org', 'http://10.10.10.62:8016');
  const b = account('usera@10.10.10.62:8120', 'usera@example.org', 'http://10.10.10.62:8120');
  const c = account('userb@mail.example.org', 'userb@example.org', 'https://mail.example.org');

  it('tells two accounts with the same address apart by their server', () => {
    expect(deviceSyncAccountLabel(a, [a, b, c])).toBe('usera@example.org (10.10.10.62:8016)');
    expect(deviceSyncAccountLabel(b, [a, b, c])).toBe('usera@example.org (10.10.10.62:8120)');
  });

  it('is just the address when it is the only one with it', () => {
    expect(deviceSyncAccountLabel(c, [a, b, c])).toBe('userb@example.org');
    expect(deviceSyncAccountLabel(a, [a, c])).toBe('usera@example.org');
    // A default port is left out of the server.
    const d = account('usera@mail.example.org', 'USERA@example.org', 'https://mail.example.org');
    expect(deviceSyncAccountLabel(d, [a, d])).toBe('USERA@example.org (mail.example.org)');
  });

  it('is what the row and its switch are labelled with', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'DeviceSyncAccountRow.tsx'), 'utf8');
    expect(src).toMatch(/const accountLabel = React\.useMemo\(\(\) => deviceSyncAccountLabel\(account, accounts\), \[account, accounts\]\);/);
    expect(src).toMatch(/'Sync \{account\} to this device', \{ account: accountLabel \}/);
  });
});
