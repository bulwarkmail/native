// Why a FileNode write failed, from the SetError the files API threw, for the
// Files alerts to explain (webmail lib/file-errors.ts).

import { JMAPMethodError, jmapErrorProperties } from '../api/jmap-result';
import type { TranslateFn } from '../stores/locale-store';

export type FileErrorKind = 'overQuota' | 'tooDeep' | 'invalidName' | 'forbidden' | 'tooLarge';

export function fileErrorKind(error: unknown): FileErrorKind | null {
  if (!(error instanceof JMAPMethodError)) return null;
  switch (error.type) {
    // Stalwart 1.0, once an administrator limits files or folders per account.
    case 'overQuota':
      return 'overQuota';
    // 1.0 for content over 4 GiB.
    case 'tooLarge':
      return 'tooLarge';
    case 'forbidden':
      return 'forbidden';
    case 'invalidProperties': {
      const properties = jmapErrorProperties(error);
      if (properties.includes('name')) return 'invalidName';
      // `parentId` is refused for other reasons too (the folder is gone, a
      // folder moved into itself); only 1.0's description, "Maximum folder
      // depth exceeded.", tells depth apart.
      if (properties.includes('parentId') && /depth/i.test(error.message)) return 'tooDeep';
      return null;
    }
    default:
      return null;
  }
}

/**
 * The text an alert shows for a failed file action: what the server's
 * refusal means when it is one of the known ones, else its own message.
 */
export function fileErrorMessage(error: unknown, t: TranslateFn): string {
  switch (fileErrorKind(error)) {
    case 'overQuota':
      return t('files.error_over_quota', 'You have reached the limit on files or folders. Delete some and try again.');
    case 'tooDeep':
      return t('files.error_too_deep', 'Folders cannot be nested this deeply.');
    case 'invalidName':
      return t('files.error_invalid_name', 'The server does not accept this name.');
    case 'forbidden':
      return t('files.error_forbidden', 'You do not have permission to do this here.');
    case 'tooLarge':
      return t('files.error_too_large', 'This file is too large for the server.');
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
