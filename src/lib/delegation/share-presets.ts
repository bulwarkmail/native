import { allowedLevels } from './delegation';

export type MailboxPresetKey = 'read' | 'readWrite' | 'manager';

/**
 * The folder share roles the organisation allows (webmail
 * share-collection-dialog.tsx): without `write` in the policy's
 * `sharingRights.allowedValues`, only Read only. Same rule as the
 * Delegates page (allowedLevels).
 */
export function allowedMailboxPresets(allowedValues: unknown[] | null | undefined): MailboxPresetKey[] {
  const writeAllowed = allowedLevels(Array.isArray(allowedValues) ? allowedValues : null).includes('write');
  return writeAllowed ? ['read', 'readWrite', 'manager'] : ['read'];
}
