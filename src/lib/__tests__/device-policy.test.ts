import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sharing from 'expo-sharing';
import { givenPolicy } from './org-policy-helpers';
import { organisationFor, mergeOrganisation, DEFAULT_ORGANISATION } from '../org-organisation';
import { sanitizePolicy } from '../org-policy';
import { DevicePolicyError, canDownload, canExport, devicesForAccount } from '../device-policy';
import { watermarkText } from '../watermark';
import { downloadAttachment, shareAttachment, shareEmailEml, shareLocalFile, saveLocalFileCopy } from '../email-export';

// The organisation's device rules (webmail lib/device-policy.ts,
// organisation.devices): no downloads, no export, the offline caps.

const devices = (d: Record<string, unknown>) => ({ organisation: { devices: d } });

beforeEach(() => {
  vi.clearAllMocks();
  givenPolicy(null);
});

describe('organisation settings', () => {
  it('merges scopes the webmail way: caps keep the strictest, the announcement is replaced whole', () => {
    const policy = sanitizePolicy({
      organisation: {
        devices: { offlineMaxDays: 30, noDownloads: true },
        announcement: { id: 'a1', text: { en: 'Global' }, severity: 'warning', dismissible: false },
        vacationTemplates: { library: [{ id: 'g', name: 'Global' }] },
      },
      scopes: [
        { id: 'eu', match: { domains: ['example.org'] }, policy: { organisation: {
          devices: { offlineMaxDays: 90, offlineMaxTotalMb: 200 },
          announcement: { id: 'a2', text: { en: 'EU' } },
          vacationTemplates: { library: [{ id: 'eu', name: 'EU' }] },
        } } },
      ],
    })!;
    const org = organisationFor(policy, { email: 'ada@example.org', groups: [] });
    expect(org.devices.offlineMaxDays).toBe(30);
    expect(org.devices.offlineMaxTotalMb).toBe(200);
    expect(org.devices.noDownloads).toBe(true);
    // Replaced whole: the scope's own severity and close default back.
    expect(org.announcement).toMatchObject({ id: 'a2', text: { en: 'EU' }, severity: 'info', dismissible: true });
    expect(org.vacationTemplates.library.map((t) => t.id)).toEqual(['g', 'eu']);
    // Another domain gets the global settings only.
    expect(organisationFor(policy, { email: 'bob@other.org', groups: [] }).devices.offlineMaxDays).toBe(30);
  });

  it('drops what is not a valid setting', () => {
    const org = mergeOrganisation(DEFAULT_ORGANISATION, {
      devices: { noDownloads: 'yes' as unknown as boolean },
    });
    expect(org.devices.noDownloads).toBe('yes'); // mergeOrganisation trusts its input...
    const policy = sanitizePolicy({ organisation: { devices: { noDownloads: 'yes', offlineMaxDays: -5 } } })!;
    const checked = organisationFor(policy, null);
    expect(checked.devices.noDownloads).toBe(false); // ...organisationFor sanitises first
    expect(checked.devices.offlineMaxDays).toBe(0);
  });
});

describe('download and export guards', () => {
  it('allows everything without a policy', () => {
    expect(canDownload()).toBe(true);
    expect(canExport()).toBe(true);
  });

  it('refuses attachment and file hand-offs when downloads are off', async () => {
    givenPolicy(devices({ noDownloads: true }));
    expect(devicesForAccount().noDownloads).toBe(true);
    await expect(downloadAttachment('b1', 'a.pdf', 'application/pdf')).rejects.toBeInstanceOf(DevicePolicyError);
    await expect(shareAttachment('b1', 'a.pdf', 'application/pdf')).rejects.toBeInstanceOf(DevicePolicyError);
    const { File } = await import('expo-file-system');
    const local = new (File as unknown as new (uri: string) => { name: string; uri: string })('file:///cache/a.pdf');
    await expect(shareLocalFile(local as never, 'application/pdf')).rejects.toThrow('Your organisation turned off downloads.');
    await expect(saveLocalFileCopy(local as never, 'application/pdf')).rejects.toBeInstanceOf(DevicePolicyError);
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    // Export is a separate switch.
    expect(canExport()).toBe(true);
  });

  it('refuses the EML export when export is off', async () => {
    givenPolicy(devices({ noExport: true }));
    await expect(shareEmailEml('b1', null, 'Subject')).rejects.toThrow('Your organisation turned off exporting mail.');
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('ignores a policy cached from another webmail than the account signed in through', async () => {
    givenPolicy(devices({ noDownloads: true }));
    const { useAccountStore } = await import('../../stores/account-store');
    const [a] = useAccountStore.getState().accounts;
    useAccountStore.setState({ accounts: [{ ...a, webmailUrl: 'https://elsewhere.example.org' }] });
    expect(canDownload()).toBe(true);
  });
});

describe('watermark', () => {
  it('is the address and the date', () => {
    expect(watermarkText('ada@example.org', new Date('2026-11-01T12:00:00Z'), 'en-GB')).toBe('ada@example.org · 1 Nov 2026');
    expect(watermarkText('  ', new Date('2026-11-01T12:00:00Z'), 'en-GB')).toBe('1 Nov 2026');
  });
});
