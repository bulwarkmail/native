// Whether the identity editor holds changes that closing it would drop
// (webmail use-discard-changes.tsx, 9d3ae2203). Close, Cancel and Android
// Back used to close it straight away.

export interface IdentityDraftFields {
  name: string;
  email: string;
  replyTo: string;
  bcc: string;
  textSignature: string;
  htmlSignature: string;
}

const FIELDS: (keyof IdentityDraftFields)[] = ['name', 'email', 'replyTo', 'bcc', 'textSignature', 'htmlSignature'];

export function identityDraftChanged(initial: IdentityDraftFields | null, current: IdentityDraftFields | null): boolean {
  if (!initial || !current) return false;
  return FIELDS.some((field) => initial[field] !== current[field]);
}
