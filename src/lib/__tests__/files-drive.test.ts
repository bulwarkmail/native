import { describe, it, expect } from 'vitest';
import type { JMAPSession } from '../../api/types';
import { driveChange, type DriveScope } from '../files-drive';
import { sessionFingerprint } from '../server-fingerprint';

// When the Files screen starts its drive over, reads it again in place, or
// leaves it. It used to start over only when the local account id changed,
// which leaves the port out and stays the same when the server at the
// address is reinstalled: the old server's folders stayed on screen, with
// ids that name other files on the new one.

const session = (apiUrl: string, version: '0.16.23' | '1.0'): JMAPSession => ({
  apiUrl,
  downloadUrl: '',
  uploadUrl: '',
  eventSourceUrl: '',
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'f' },
  accounts: {
    f: {
      name: 'userc@example.org',
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: {
        'urn:ietf:params:jmap:mail': {},
        'urn:ietf:params:jmap:filenode': {},
        ...(version === '1.0' ? { 'urn:ietf:params:jmap:principals:owner': {}, 'urn:ietf:params:jmap:metadata': {} } : {}),
      },
    },
  },
  capabilities: {
    'urn:ietf:params:jmap:core': {},
    ...(version === '1.0' ? { 'urn:ietf:params:jmap:metadata': {} } : {}),
  },
  state: 'b3bed0bb',
} as unknown as JMAPSession);

const ACCOUNT = 'userc@10.10.10.61';
const v016 = session('http://10.10.10.61:8016/jmap/', '0.16.23');
const v10 = session('http://10.10.10.61:8110/jmap/', '1.0');
const loadedFrom = (s: JMAPSession | null, account = ACCOUNT): DriveScope => ({
  account,
  server: s ? sessionFingerprint(s) : null,
});

describe('driveChange', () => {
  it('reads the drive when the screen opens', () => {
    expect(driveChange(undefined, ACCOUNT, v016)).toEqual({ action: 'load', scope: loadedFrom(v016) });
  });

  it('starts over for another server at the same address: another port (0.16.23 to 1.0)', () => {
    expect(driveChange(loadedFrom(v016), ACCOUNT, v10)).toEqual({ action: 'reset', scope: loadedFrom(v10) });
  });

  it('starts over for a server reinstalled at the same address (0.16.23 to 1.0)', () => {
    const reinstalled = session('http://10.10.10.61:8016/jmap/', '1.0');
    expect(driveChange(loadedFrom(v016), ACCOUNT, reinstalled).action).toBe('reset');
  });

  it('starts over for another account', () => {
    expect(driveChange(loadedFrom(v10), 'usera@10.10.10.61', v10).action).toBe('reset');
    expect(driveChange(loadedFrom(v10), null, null).action).toBe('reset');
  });

  it('reads the drive again in place for a new session of the same server (Stalwart 1.0)', () => {
    const again = { ...v10 };
    expect(driveChange(loadedFrom(v10), ACCOUNT, again)).toEqual({ action: 'reload', scope: loadedFrom(v10) });
    // Opened offline: the first session reads it.
    expect(driveChange(loadedFrom(null), ACCOUNT, v10)).toEqual({ action: 'reload', scope: loadedFrom(v10) });
  });

  it('leaves the drive alone when the session is lost', () => {
    expect(driveChange(loadedFrom(v10), ACCOUNT, null)).toEqual({ action: 'keep', scope: loadedFrom(v10) });
  });
});
