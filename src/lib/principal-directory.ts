import type { PrincipalListing } from '../api/files';

/** What a share sheet says under its search box about the people it lists. */
export type DirectoryNotice = 'failed' | 'restricted' | 'not_browsable';

/**
 * The notice for a principal listing that isn't the whole directory, or null
 * when it is. Only Stalwart 1.0's own refusal says who is still listed and
 * what an administrator can do about it; any other refusal (a 0.16 role
 * without the permission) gets the generic wording.
 */
export function directoryNotice(
  listing: Pick<PrincipalListing, 'status' | 'directoryQueriesOff'>,
): DirectoryNotice | null {
  if (listing.status === 'ok') return null;
  if (listing.status === 'error') return 'failed';
  return listing.directoryQueriesOff ? 'restricted' : 'not_browsable';
}
