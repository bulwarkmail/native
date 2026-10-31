// What the organisation policy says about "Recover deleted items". The
// webmail reads it from its policy store: the admin can hide the page
// (restriction `deletedItemsRecovery`) and limit the list to the last N days
// (`organisation.recovery.days`, 0 = everything the server keeps). The app
// has no policy route yet, so this answers "shown, no limit"; once the
// policy arrives, this is the one place to plug it in.

export interface RecoveryPolicy {
  /** The admin hid the page: nothing is asked of the server. */
  hidden: boolean;
  /** Days of deleted mail to list; 0 = all the server keeps. */
  days: number;
}

export function recoveryPolicy(): RecoveryPolicy {
  return { hidden: false, days: 0 };
}
