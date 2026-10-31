// What the organisation policy says about Delegates. The webmail reads it
// from its policy store: the admin can hide the page (restriction
// `delegation`), limit the rights offered (`sharingRights.allowedValues`,
// read and/or write) and switch calendars, contacts or files off
// (`calendarEnabled`, `contactsEnabled`, `filesEnabled`). The app has no
// policy route yet, so this answers "shown, every right, every app"; once
// the policy arrives, this is the one place to plug it in.

export interface DelegationPolicy {
  /** The admin hid the page. */
  hidden: boolean;
  /** `sharingRights.allowedValues`; null = no limit. */
  allowedValues: unknown[] | null;
  calendarsEnabled: boolean;
  contactsEnabled: boolean;
  filesEnabled: boolean;
}

export function delegationPolicy(): DelegationPolicy {
  return { hidden: false, allowedValues: null, calendarsEnabled: true, contactsEnabled: true, filesEnabled: true };
}
