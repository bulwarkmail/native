/**
 * "Report phishing" (#124), ported from the webmail's lib/phishing-report.ts:
 * sends a message to the address the admin set (policy.json
 * `organisation.phishingReport`), one report per message.
 *
 * - One report per message, also for a selection: report desks (Microsoft
 *   Defender among them) discard reports with several messages attached,
 *   and RFC 5965 §2(e) says one message per report.
 * - No copy in Sent: a live phishing message shouldn't sit there to be
 *   clicked again; the admin's mailbox is the record.
 * - The forward format attaches the original by its blobId, so nothing is
 *   uploaded. A message of another account (a shared or group mailbox) has
 *   its blob copied to the sending account first (Blob/copy).
 * - The report skips the composer's send checks, signature and send delay:
 *   the address is the admin's, and the report is not the user's mail.
 */

import type { Email, Identity, Mailbox } from '../api/types';
import type { OrgPolicy } from './org-policy';
import { emailExportFilename } from './download-filename';

/** RFC 9051 §2.3.2: the user reported the message as phishing. */
export const PHISHING_KEYWORD = '$phishing';

export type PhishingReportFormat = 'forward' | 'arf';

export interface PhishingReportSetup {
  address: string;
  format: PhishingReportFormat;
}

// The webmail's sanitiser keeps only an address it accepts; policy.json is
// written by hand, so the app checks again (lib/org-policy).
const REPORT_ADDRESS = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;

/** The setup in a policy; null while reporting is off (no address). */
export function phishingReportSetup(policy: Pick<OrgPolicy, 'organisation'> | null | undefined): PhishingReportSetup | null {
  const section = policy?.organisation?.phishingReport;
  if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
  const { address, format } = section as { address?: unknown; format?: unknown };
  if (typeof address !== 'string') return null;
  const clean = address.trim().toLowerCase();
  if (!clean || clean.length > 320 || !REPORT_ADDRESS.test(clean)) return null;
  return { address: clean, format: format === 'arf' ? 'arf' : 'forward' };
}

/** Folders whose messages are the user's own: nothing to report there. */
const OWN_MAIL_ROLES = new Set(['sent', 'drafts', 'scheduled']);

/**
 * Whether `email`, shown in a folder of `mailboxRole`, can be reported.
 * `folderRoles`: the roles of the folders the message itself is in (search
 * results and All mail show the user's own sent mail too). List rows carry
 * no blobId; the report fetches it, so it isn't asked for here.
 */
export function isReportable(
  email: Pick<Email, 'keywords'>,
  mailboxRole?: string | null,
  folderRoles: readonly string[] = [],
): boolean {
  if (mailboxRole && OWN_MAIL_ROLES.has(mailboxRole)) return false;
  if (folderRoles.some((role) => OWN_MAIL_ROLES.has(role))) return false;
  if (email.keywords?.$draft) return false;
  // Reported already: it is in Junk with its links off.
  return email.keywords?.[PHISHING_KEYWORD] !== true;
}

/** The roles of the folders a message is in, from the folders the store knows. */
export function folderRolesOf(email: Pick<Email, 'mailboxIds'>, mailboxes: Mailbox[]): string[] {
  const roles: string[] = [];
  for (const id of Object.keys(email.mailboxIds ?? {})) {
    if (!email.mailboxIds[id]) continue;
    const box = mailboxes.find((m) => m.id === id || m.originalId === id);
    if (box?.role) roles.push(box.role);
  }
  return roles;
}

/** The messages of `emails` that can be reported from a folder of `mailboxRole`. */
export function reportableOf<T extends Pick<Email, 'keywords' | 'mailboxIds'>>(
  emails: T[],
  mailboxRole: string | null | undefined,
  mailboxes: Mailbox[],
): T[] {
  return emails.filter((email) => isReportable(email, mailboxRole, folderRolesOf(email, mailboxes)));
}

/** The subject of the report: Microsoft's reporting mailboxes read "Phishing:" as the verdict. */
export function reportSubject(subject: string | undefined | null): string {
  const clean = (subject ?? '').replace(/[\r\n]+/g, ' ').trim();
  return clean ? `Phishing: ${clean}` : 'Phishing';
}

/** The short text of a forwarded report. English: it is read by the security team, not the user. */
export function reportText(reporter: { name?: string; email: string }): string {
  const who = reporter.name?.trim() ? `${reporter.name.trim()} <${reporter.email}>` : reporter.email;
  return `Reported as phishing by ${who} with Bulwark.\r\nThe reported message is attached unchanged.\r\n`;
}

/** True when `email` is the login's own address; a bare login ("user") matches its local part. */
function matchesLogin(email: string, username: string): boolean {
  const address = email.trim().toLowerCase();
  const login = username.trim().toLowerCase();
  if (address === login) return true;
  return !login.includes('@') && address.split('@')[0] === login;
}

/**
 * The identity a report goes out from: the login's own address first, its
 * canonical identity (which cannot be deleted) ahead of an alias; wildcard
 * identities can't send. The webmail's sortIdentities.
 */
export function reporterIdentity(identities: Identity[], username: string): Identity | null {
  const usable = identities.filter((identity) => identity.email && !identity.email.includes('*'));
  const rank = (identity: Identity) => (matchesLogin(identity.email, username) ? (identity.mayDelete ? 1 : 0) : 2);
  return [...usable].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** The name the original goes by as an attachment of the report. */
export function reportAttachmentName(email: Email): string {
  return emailExportFilename(email, { template: '{date}-{subject}' });
}
