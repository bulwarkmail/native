import type { EmailAddress, Identity } from '../api/types';
import { generateSubAddress } from './sub-addressing';
import { sanitizeDisplayName } from './rfc5322-mailbox';

export interface FromOverride {
  name: string;
  email: string;
}

/**
 * The composer's custom From, or null when the organisation turned custom
 * From off (`customFromEnabled`, webmail email-composer.tsx
 * fromOverrideEnabled). An override set earlier, by hand or by the reply
 * identity match, then no longer applies.
 */
export function activeFromOverride(
  override: FromOverride | null,
  customFromEnabled: boolean,
): FromOverride | null {
  return customFromEnabled && override ? override : null;
}

/**
 * The From header and envelope sender of an outgoing message: the custom From
 * when one applies, else the identity's address with its sub-address tag. A
 * From that isn't the identity's own address still goes out through the
 * identity's envelope sender.
 */
export function composeSenderAddress(
  identity: Identity,
  opts: {
    fromOverride: FromOverride | null;
    customFromEnabled: boolean;
    subAddressTag: string;
    subAddressDelimiter?: string;
  },
): { from: EmailAddress; envelopeMailFrom?: string } {
  const override = activeFromOverride(opts.fromOverride, opts.customFromEnabled);
  let from: EmailAddress;
  if (override?.email.trim()) {
    const overrideName = sanitizeDisplayName(override.name);
    from = overrideName ? { name: overrideName, email: override.email.trim() } : { email: override.email.trim() };
  } else {
    const name = sanitizeDisplayName(identity.name);
    const email = opts.subAddressTag
      ? generateSubAddress(identity.email, opts.subAddressTag, opts.subAddressDelimiter)
      : identity.email;
    from = name ? { name, email } : { email };
  }
  const envelopeMailFrom = from.email.toLowerCase() !== identity.email.toLowerCase() ? identity.email : undefined;
  return { from, envelopeMailFrom };
}
