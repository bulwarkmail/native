import { getIdentities } from '../identity';
import type { Identity } from '../types';

/**
 * The identity with the login's own address, for the live checks that send
 * From it. A login in a group (usera in team@ on the test servers) also has
 * the group's identity in its own account, on Stalwart 1.x listed first, and
 * Stalwart refuses a submission whose From isn't the identity's address
 * ("Envelope mailFrom does not match identity email address").
 */
export async function ownIdentity(login: string): Promise<Identity> {
  const identities = await getIdentities();
  const own = identities.find((i) => i.email.toLowerCase() === login.toLowerCase());
  if (!own) throw new Error(`no identity for ${login}: ${identities.map((i) => i.email).join(', ')}`);
  return own;
}
