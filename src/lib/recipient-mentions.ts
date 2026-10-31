// "@" mentions in the message body (webmail #1134), ported from the webmail's
// lib/recipient-mentions.ts. Typing "@" at the start of a word offers the
// message's To and Cc recipients, then contacts who aren't on the message
// yet; picking one inserts "@FirstName" as a mailto: link and adds a
// contact to To (webmail default `mentionAddsRecipientTo: 'to'`).

import { expandRecipients, type Recipient } from './recipients';

/** A recipient an @ in the message body can address. */
export interface MentionCandidate {
  /** What goes after the @ in the body. */
  label: string;
  name?: string;
  email: string;
  /** Not a recipient yet: picking them adds them to this field. */
  addsTo?: 'to' | 'cc';
}

/** Someone from the contacts, the directory or recent recipients. */
export interface MentionContact {
  name?: string;
  email: string;
}

/** How many contacts an @ offers after the recipients. */
const CONTACT_LIMIT = 8;

function letterCount(value: string): number {
  return value.match(/\p{L}/gu)?.length ?? 0;
}

/** The mailbox part of an address, without a +subaddress tag. */
function localPartOf(email: string): string {
  const local = email.slice(0, email.lastIndexOf('@'));
  return local.split('+')[0] || local;
}

/** "Mustermann, Max" -> "Max Mustermann"; any other name as is. */
function naturalOrder(name: string): string {
  const parts = name.split(',');
  if (parts.length !== 2 || !parts[1].trim()) return name;
  return `${parts[1].trim()} ${parts[0].trim()}`;
}

/**
 * "max.mustermann" -> "Max", "anna-lena.schmidt" -> "Anna-Lena". Null when
 * the first part is a bare initial ("m.mustermann").
 */
function givenNameFromLocalPart(localPart: string): string | null {
  const first = localPart.split(/[._]/)[0];
  if (letterCount(first) <= 1) return null;
  return first.replace(/(^|-)(\p{Ll})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase());
}

/** The words of a display name, without the punctuation around them. */
function nameWords(name: string): string[] {
  return naturalOrder(name)
    .split(/\s+/)
    .map((raw) => raw.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}.]+$/u, ''))
    .filter(Boolean);
}

/**
 * The given name in a display name: "Max Mustermann", "Mustermann, Max" and
 * "Dr. Max Mustermann" all give "Max". Null when the name opens with a bare
 * initial ("M. Mustermann").
 */
function givenNameFromDisplayName(name: string): string | null {
  // Some systems put the mailbox name in the display name.
  if (!/\s/.test(name) && /\p{L}[._]\p{L}/u.test(name)) return givenNameFromLocalPart(name);
  for (const word of nameWords(name)) {
    if (letterCount(word) <= 1) return null;
    // Titles and abbreviations: "Dr.", "Prof.", "Dipl.-Ing."
    if (word.endsWith('.')) continue;
    return word;
  }
  return null;
}

const UMLAUT_SPELLINGS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** Whether two names match as an address spells them: "Jürgen" and "juergen". */
function spelledAlike(a: string, b: string): boolean {
  const key = (s: string) => fold(s.normalize('NFC').toLowerCase().replace(/[äöüß]/g, (c) => UMLAUT_SPELLINGS[c]));
  return key(a) === key(b);
}

/**
 * A display name worth deriving a label from: not empty, not an address.
 * Capped because a reply-all takes it from the incoming message.
 */
function usableName(name: string | undefined): string | undefined {
  const trimmed = name?.trim().slice(0, 200).replace(/^(['"])(.*)\1$/, '$2').trim();
  return trimmed && !trimmed.includes('@') ? trimmed : undefined;
}

/**
 * First name to put after the @. A firstname.lastname@ address tells which
 * word of the display name is the first name; otherwise it is the display
 * name's first word, or the address's first part when no name is known.
 */
export function mentionLabel(name: string | undefined, email: string): string {
  const localPart = localPartOf(email);
  const fromAddress = givenNameFromLocalPart(localPart);
  const usable = usableName(name);
  if (usable) {
    const confirmed = fromAddress && /[._]/.test(localPart)
      ? nameWords(usable).find((word) => spelledAlike(word, fromAddress))
      : undefined;
    const given = confirmed || givenNameFromDisplayName(usable);
    if (given) return given;
  }
  return fromAddress ?? localPart;
}

function clashingLabels(candidates: MentionCandidate[]): Set<string> {
  const seen = new Set<string>();
  const clashes = new Set<string>();
  for (const { label } of candidates) {
    const key = label.toLowerCase();
    if (seen.has(key)) clashes.add(key);
    seen.add(key);
  }
  return clashes;
}

/**
 * Two candidates who would both be "@Max" are told apart by full name, or
 * by mailbox name where no name is known - and by mailbox name when even
 * the full names match.
 */
function distinguishLabels(candidates: MentionCandidate[]): MentionCandidate[] {
  const clashes = clashingLabels(candidates);
  for (const c of candidates) {
    if (clashes.has(c.label.toLowerCase())) c.label = c.name ? naturalOrder(c.name) : localPartOf(c.email);
  }
  const stillClashing = clashingLabels(candidates);
  for (const c of candidates) {
    if (stillClashing.has(c.label.toLowerCase())) c.label = localPartOf(c.email);
  }
  return candidates;
}

/**
 * The recipients an @ in the message body can address: To and Cc, contact
 * groups expanded into their members, each address once. Bcc is left out on
 * purpose - naming a blind-copied recipient in the body would disclose them
 * to everyone else on the message.
 */
export function buildMentionCandidates(to: Recipient[], cc: Recipient[]): MentionCandidate[] {
  return distinguishLabels(expandRecipients([...to, ...cc])
    .filter((r) => r.email.lastIndexOf('@') > 0)
    .map((r) => {
      const name = usableName(r.name);
      return { label: mentionLabel(name, r.email), name, email: r.email };
    }));
}

/**
 * What an @ followed by `query` offers: the matching recipients, then
 * matching contacts who aren't on the message yet, marked with the field
 * picking them adds them to. `contacts` must already leave out Bcc
 * recipients, who an @ never names.
 */
export function mentionSuggestions(
  recipients: MentionCandidate[],
  contacts: MentionContact[],
  query: string,
  addsTo: 'to' | 'cc',
): MentionCandidate[] {
  const matched = filterMentionCandidates(recipients, query);
  const seen = new Set(recipients.map((r) => r.email.toLowerCase()));
  const extra: MentionCandidate[] = [];
  for (const contact of contacts) {
    if (extra.length >= CONTACT_LIMIT) break;
    const key = contact.email.toLowerCase();
    if (contact.email.lastIndexOf('@') <= 0 || seen.has(key)) continue;
    seen.add(key);
    const name = usableName(contact.name);
    const candidate = { label: mentionLabel(name, contact.email), name, email: contact.email, addsTo };
    if (filterMentionCandidates([candidate], query).length > 0) extra.push(candidate);
  }
  if (extra.length === 0) return matched;
  // A contact who would also be "@Max" next to a recipient Max goes by full
  // name, or mailbox name. The recipient keeps "@Max".
  const taken = new Set(recipients.map((r) => r.label.toLowerCase()));
  distinguishLabels(extra);
  for (const c of extra) {
    if (!taken.has(c.label.toLowerCase())) continue;
    c.label = c.name && !taken.has(naturalOrder(c.name).toLowerCase()) ? naturalOrder(c.name) : localPartOf(c.email);
  }
  return [...matched, ...extra];
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Candidates whose label, a word of their name, their address or a part of
 * their mailbox name starts with what was typed after the @ - case and
 * accents ignored, so "jue" finds juergen.mueller@ and "jü" finds Jürgen.
 */
export function filterMentionCandidates(candidates: MentionCandidate[], query: string): MentionCandidate[] {
  const typed = fold(query);
  if (!typed) return candidates;
  return candidates.filter((c) =>
    [c.label, c.email, ...(c.name?.split(/\s+/) ?? []), ...localPartOf(c.email).split(/[._-]/)]
      .some((term) => fold(term).startsWith(typed)),
  );
}

/**
 * A mailto: href for the address. Characters that would start a query or
 * fragment (a crafted reply-all address) are escaped, so the link can only
 * ever address this one mailbox.
 */
export function mentionHref(email: string): string {
  return `mailto:${email.replace(/[%?#&\s"'<>]/g, (c) => encodeURIComponent(c))}`;
}

/**
 * Add a mentioned contact to To (or Cc) unless the address is on the message
 * already, groups included (webmail addMentionedRecipient). Returns the same
 * list when nothing changes; `make` builds the field's entry.
 */
export function addMentionedRecipient<T extends Recipient>(
  list: T[],
  candidate: MentionCandidate,
  make: (candidate: MentionCandidate) => T,
): T[] {
  const key = candidate.email.trim().toLowerCase();
  if (expandRecipients(list).some((r) => r.email.trim().toLowerCase() === key)) return list;
  return [...list, make(candidate)];
}
