import { organisationForAccount, useAccountOrganisation } from './account-organisation';
import { setDeviceRulesProvider } from './device-rules';
import type { OrgDevices } from './org-organisation';

// The organisation's device rules (policy.json `organisation.devices`,
// webmail lib/device-policy.ts): no attachment and file downloads, no mail
// export, the watermark and the offline caps. The app shows one account at
// a time, and every download and export goes through the JMAP client of
// the active account, so the active account's rules apply there
// (devicesForAccount(null) in the webmail).
//
// Downloads here are everything that hands a file to another app: Open
// with, Share, Save a copy. The in-app preview stays, as in the webmail.
// Someone with a rooted phone, another mail app or a screenshot gets around
// all of this; the webmail's admin page says so.

export type DevicePolicy = OrgDevices;
export { DevicePolicyError } from './download-guard';

/** The device rules of an account (local registry id); the active one for null. */
export function devicesForAccount(accountId?: string | null): DevicePolicy {
  return organisationForAccount(accountId).devices;
}

export function useDevicePolicy(accountId?: string | null): DevicePolicy {
  return useAccountOrganisation(accountId).devices;
}

/** Attachments and files may leave the app (Open with, Share, Save). */
export function canDownload(accountId?: string | null): boolean {
  return !devicesForAccount(accountId).noDownloads;
}

/** Messages may be exported (EML). */
export function canExport(accountId?: string | null): boolean {
  return !devicesForAccount(accountId).noExport;
}

// What the export helpers and the offline sync read (lib/device-rules.ts).
setDeviceRulesProvider(devicesForAccount);
