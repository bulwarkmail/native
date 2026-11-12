// Template placeholders, export/import envelope and filtering. Port of the
// webmail's lib/template-utils.ts + lib/template-types.ts (DOM-free: the
// tag-stripping DOMPurify pass is replaced by a regex strip).

import type { EmailTemplate } from '../stores/templates-store';
import { generateUUID } from './uuid';
import { intlLocale } from './intl-locale';
import { escapeHtml } from './email-html';
import { decodeEntities } from './verification-code';

export const BUILT_IN_PLACEHOLDERS = [
  'recipient_name',
  'company',
  'date',
  'day_of_week',
  'sender_name',
] as const;

export type BuiltInPlaceholder = (typeof BUILT_IN_PLACEHOLDERS)[number];

// {{name}} or {{name:default}}. In a subject or a plain body the default is
// text and may hold "<" and ">" ({{contact:Jane <jane@x.com>}}). In an HTML
// body those are markup, so a default stops at a tag; a "<" typed in the
// editor is stored as &lt; there.
const TEXT_PLACEHOLDER_REGEX = /\{\{(\w+)(?::([^{}\n]*))?\}\}/g;
const HTML_PLACEHOLDER_REGEX = /\{\{(\w+)(?::([^{}<>\n]*))?\}\}/g;
const MAX_TEMPLATE_NAME_LENGTH = 200;

const placeholderRegex = (html?: boolean) => (html ? HTML_PLACEHOLDER_REGEX : TEXT_PLACEHOLDER_REGEX);

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

export function extractPlaceholders(text: string, options: { html?: boolean } = {}): string[] {
  const matches = new Set<string>();
  for (const match of text.matchAll(placeholderRegex(options.html))) {
    matches.add(match[1]);
  }
  return Array.from(matches);
}

/**
 * Fill in {{placeholders}}. Values are text: escaped for an HTML template,
 * kept as typed for a plain one, so "Smith <j@x.com>" survives either way.
 */
export function substitutePlaceholders(
  text: string,
  values: Record<string, string>,
  options: { html?: boolean } = {},
): string {
  return text.replace(placeholderRegex(options.html), (full, name: string) => {
    if (values[name] === undefined) return full;
    return options.html ? escapeHtml(values[name]) : values[name];
  });
}

export function hasUnresolvedPlaceholders(text: string, options: { html?: boolean } = {}): boolean {
  return new RegExp(placeholderRegex(options.html).source).test(text);
}

export function validateTemplateName(name: string): 'empty' | 'too_long' | null {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length > MAX_TEMPLATE_NAME_LENGTH) return 'too_long';
  return null;
}

export interface AutoFillContext {
  senderName?: string;
  recipientName?: string;
  locale?: string;
}

export function getAutoFilledPlaceholders(
  context: AutoFillContext,
): Record<string, string> {
  const now = new Date();
  const intlTag = intlLocale(context.locale);

  const values: Record<string, string> = {};
  try {
    values.date = now.toLocaleDateString(intlTag, { year: 'numeric', month: 'long', day: 'numeric' });
    values.day_of_week = now.toLocaleDateString(intlTag, { weekday: 'long' });
  } catch {
    values.date = now.toDateString();
    values.day_of_week = now.toLocaleDateString(undefined, { weekday: 'long' });
  }

  if (context.senderName) {
    values.sender_name = context.senderName;
  }
  if (context.recipientName) {
    values.recipient_name = context.recipientName;
  }

  return values;
}

export function getPlaceholdersFromTemplate(template: Pick<EmailTemplate, 'subject' | 'body' | 'isHTML'>): string[] {
  return Array.from(new Set([
    ...extractPlaceholders(template.subject),
    ...extractPlaceholders(template.body, { html: !!template.isHTML }),
  ]));
}

/** The default each placeholder carries ({{name:default}}), first one wins. */
export function getPlaceholderDefaults(template: Pick<EmailTemplate, 'subject' | 'body' | 'isHTML'>): Map<string, string> {
  const defaults = new Map<string, string>();
  const collect = (text: string, html: boolean) => {
    for (const [, name, value] of text.matchAll(placeholderRegex(html))) {
      if (value === undefined || defaults.has(name)) continue;
      defaults.set(name, html ? decodeEntities(value) : value);
    }
  };
  collect(template.subject, false);
  collect(template.body, !!template.isHTML);
  return defaults;
}

/**
 * The fields the fill sheet asks for: every placeholder the app can't fill
 * itself, each started with its default (webmail placeholder-fill-modal).
 */
export function placeholderPromptValues(
  template: Pick<EmailTemplate, 'subject' | 'body' | 'isHTML'>,
  autoFilled: Record<string, string>,
): Record<string, string> {
  const defaults = getPlaceholderDefaults(template);
  return Object.fromEntries(
    getPlaceholdersFromTemplate(template)
      .filter((p) => autoFilled[p] === undefined)
      .map((p) => [p, defaults.get(p) ?? '']),
  );
}

export function isBuiltInPlaceholder(name: string): boolean {
  return (BUILT_IN_PLACEHOLDERS as readonly string[]).includes(name);
}

export function filterTemplates(templates: EmailTemplate[], query: string): EmailTemplate[] {
  const lower = query.toLowerCase();
  return templates.filter(
    (t) =>
      t.name.toLowerCase().includes(lower) ||
      t.subject.toLowerCase().includes(lower) ||
      t.category.toLowerCase().includes(lower),
  );
}

interface ExportData {
  version: 1;
  type: 'webmail-templates';
  exportedAt: string;
  templates: EmailTemplate[];
}

/** JSON in the webmail's export shape so a file round-trips between clients. */
export function exportTemplates(templates: EmailTemplate[]): string {
  const data: ExportData = {
    version: 1,
    type: 'webmail-templates',
    exportedAt: new Date().toISOString(),
    templates,
  };
  return JSON.stringify(data, null, 2);
}

export interface ImportResult {
  templates: EmailTemplate[];
  errors: string[];
}

function sanitizeText(value: unknown): string {
  return stripTags(String(value || ''));
}

/**
 * Parse a templates export. Accepts the webmail envelope (`type:
 * 'webmail-templates'`) and, for backwards compatibility, an older RN export
 * that carried only `{ version, templates }`. Ids are regenerated so an
 * import never overwrites an existing template.
 */
export function importTemplates(json: string): ImportResult {
  const errors: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { templates: [], errors: ['invalid_json'] };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { templates: [], errors: ['invalid_format'] };
  }

  const data = parsed as Record<string, unknown>;

  if (data.type !== undefined && data.type !== 'webmail-templates') {
    return { templates: [], errors: ['invalid_type'] };
  }

  if (data.version !== undefined && data.version !== 1) {
    return { templates: [], errors: ['unsupported_version'] };
  }

  if (!Array.isArray(data.templates)) {
    return { templates: [], errors: ['invalid_templates'] };
  }

  const templates: EmailTemplate[] = [];
  for (const item of data.templates) {
    if (typeof item !== 'object' || item === null) {
      errors.push('invalid_template_entry');
      continue;
    }

    const t = item as Record<string, unknown>;
    if (typeof t.name !== 'string' || !t.name.trim()) {
      errors.push('missing_template_name');
      continue;
    }

    const recipients = t.defaultRecipients as Record<string, unknown> | undefined;
    const now = new Date().toISOString();

    templates.push({
      id: generateUUID(),
      name: sanitizeText(t.name),
      subject: sanitizeText(t.subject),
      body: t.isHTML ? String(t.body || '') : sanitizeText(t.body),
      isHTML: Boolean(t.isHTML),
      category: sanitizeText(t.category),
      defaultRecipients: recipients && typeof recipients === 'object'
        ? {
            to: Array.isArray(recipients.to) ? (recipients.to as unknown[]).map(String) : undefined,
            cc: Array.isArray(recipients.cc) ? (recipients.cc as unknown[]).map(String) : undefined,
            bcc: Array.isArray(recipients.bcc) ? (recipients.bcc as unknown[]).map(String) : undefined,
          }
        : undefined,
      identityId: typeof t.identityId === 'string' ? t.identityId : undefined,
      isFavorite: Boolean(t.isFavorite),
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : now,
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : now,
    });
  }

  return { templates, errors };
}

/** Convert a plain-text template body to composer HTML (escape + <br>). */
export function templateBodyToHtml(template: Pick<EmailTemplate, 'body' | 'isHTML'>): string {
  if (template.isHTML) return template.body;
  const escaped = template.body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
  return `<p>${escaped}</p>`;
}
