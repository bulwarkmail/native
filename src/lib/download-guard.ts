import { t } from '../stores/locale-store';
import { deviceRulesFor } from './device-rules';

// The backstop in front of every path that hands a file to another app or
// exports mail (webmail lib/download-guard.ts), for the active account: the
// app downloads and exports through the active account's client only.

export type GuardKind = 'download' | 'export';

/** Thrown by a download or export the organisation turned off; its message is for the user. */
export class DevicePolicyError extends Error {
  constructor(readonly kind: GuardKind) {
    super(kind === 'export'
      ? t('device_policy.export_blocked', 'Your organisation turned off exporting mail.')
      : t('device_policy.download_blocked', 'Your organisation turned off downloads.'));
    this.name = 'DevicePolicyError';
  }
}

export function assertCanDownload(): void {
  if (deviceRulesFor().noDownloads) throw new DevicePolicyError('download');
}

export function assertCanExport(): void {
  if (deviceRulesFor().noExport) throw new DevicePolicyError('export');
}
