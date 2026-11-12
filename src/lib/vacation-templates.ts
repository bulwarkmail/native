import { fillHtmlTemplate, fillTextTemplate } from './org-signature';
import type { OrgVacationTemplate } from './org-organisation';

// Out-of-office templates from the admin library (policy
// `organisation.vacationTemplates.library`; webmail lib/vacation-templates.ts).
// A template is filled in when the user picks it, with the placeholder style
// and empty-line rule of the organisation signature: {name}, {email},
// {company}, {start}, {end}, {deputy}, {deputy_name}. The deputy is typed
// before anything is filled, so a half-filled reply is never saved.

export const VACATION_PLACEHOLDERS = ['name', 'email', 'company', 'start', 'end', 'deputy', 'deputy_name'] as const;
export type VacationPlaceholder = (typeof VACATION_PLACEHOLDERS)[number];
export type VacationValues = Partial<Record<VacationPlaceholder, string>>;

const RE = /\{(name|email|company|start|end|deputy_name|deputy)\}/g;

/** The placeholders a template uses anywhere (subject, text or HTML). */
export function vacationPlaceholdersIn(template: Pick<OrgVacationTemplate, 'subject' | 'text' | 'html'>): VacationPlaceholder[] {
  const found = new Set<string>();
  for (const part of [template.subject, template.text, template.html]) {
    for (const match of part.matchAll(RE)) found.add(match[1]);
  }
  return VACATION_PLACEHOLDERS.filter((key) => found.has(key));
}

/** What the user has to type first: the deputy's address, and name if the text uses it. */
export function deputyFieldsNeeded(template: Pick<OrgVacationTemplate, 'subject' | 'text' | 'html'>): { address: boolean; name: boolean } {
  const used = vacationPlaceholdersIn(template);
  const name = used.includes('deputy_name');
  return { address: used.includes('deputy') || name, name };
}

/** A date of the absence in the user's language: the day alone at midnight, else day and time. */
export function formatAbsenceDate(date: Date | null | undefined, locale: string): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  const midnight = date.getHours() === 0 && date.getMinutes() === 0;
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      ...(midnight ? {} : { hour: 'numeric', minute: '2-digit' }),
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

export interface VacationFillInput {
  name: string;
  email: string;
  company: string;
  from: Date | null;
  to: Date | null;
  deputy: string;
  deputyName: string;
  locale: string;
}

export function vacationValues(input: VacationFillInput): VacationValues {
  return {
    name: input.name.trim(),
    email: input.email.trim(),
    company: input.company.trim(),
    start: formatAbsenceDate(input.from, input.locale),
    end: formatAbsenceDate(input.to, input.locale),
    deputy: input.deputy.trim(),
    deputy_name: input.deputyName.trim(),
  };
}

export interface FilledVacationTemplate {
  subject: string;
  text: string;
  /** '' when the template has no HTML version. */
  html: string;
}

// The signature fillers know the signature's placeholders only. A vacation
// placeholder is renamed to a signature one the vacation set doesn't use,
// and the signature-only placeholders in the text are kept out of the way
// meanwhile, so they stay as typed (they are no placeholders here).
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const FOREIGN = /\{(identity|domain|title|department|phone|mobile)\}/g;
const AS_SIGNATURE: Record<string, string> = { start: 'title', end: 'department', deputy: 'phone', deputy_name: 'mobile' };

function asSignatureTemplate(template: string): string {
  return template
    .replace(FOREIGN, (_, key: string) => `${OPEN}${key}${CLOSE}`)
    .replace(RE, (match, key: string) => (AS_SIGNATURE[key] ? `{${AS_SIGNATURE[key]}}` : match));
}

function restoreForeign(filled: string): string {
  return filled.replace(new RegExp(`${OPEN}([a-z]+)${CLOSE}`, 'g'), (_, key: string) => `{${key}}`);
}

/**
 * The template filled in. The subject is one line: its empty placeholders
 * go and the spaces around them close up; in the text and HTML a line whose
 * placeholders are all empty is dropped ("I'm back on {end}" with no end).
 */
export function fillVacationTemplate(template: OrgVacationTemplate, values: VacationValues): FilledVacationTemplate {
  const subject = template.subject
    .replace(RE, (_, key: string) => (values[key as VacationPlaceholder] ?? '').trim())
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .trim();
  const signatureValues = {
    name: values.name, email: values.email, company: values.company,
    title: values.start, department: values.end, phone: values.deputy, mobile: values.deputy_name,
  };
  return {
    subject,
    text: template.text.trim() ? restoreForeign(fillTextTemplate(asSignatureTemplate(template.text), signatureValues)) : '',
    html: template.html.trim() ? restoreForeign(fillHtmlTemplate(asSignatureTemplate(template.html), signatureValues)) : '',
  };
}

/** The library sorted for the picker: by category, then name. */
export function sortedVacationTemplates(library: readonly OrgVacationTemplate[]): OrgVacationTemplate[] {
  return [...library].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
}
