// Default reply/forward quote header. Port of the webmail's lib/quote-header.ts
// (without the plugin transform, which has no RN runtime).
//
// Both the forward "From:" line and the reply "On … wrote:" line show the
// full sender incl. address ("Name <email>"), like Gmail/Outlook (#482). The
// interpolated values are HTML-escaped: an unescaped "<email>" would be parsed
// as a tag by the editor and silently dropped.

import { escapeHtml } from './email-html';
import type { TimeFormat } from '../stores/settings-store';
import { intlLocale } from './intl-locale';

/** Localized label set the caller passes in (from the locale catalog). */
export interface QuoteHeaderLabels {
  /** Reply line template with `{date}` and `{from}` placeholders. */
  replyLine: string;
  forwardedSeparator: string;
  fromLabel: string;
  dateLabel: string;
  subjectLabel: string;
  /** The forward header's To and Cc lines; left out when not given. */
  toLabel?: string;
  ccLabel?: string;
}

export const DEFAULT_QUOTE_HEADER_LABELS: QuoteHeaderLabels = {
  replyLine: 'On {date}, {from} wrote:',
  forwardedSeparator: '---------- Forwarded message ----------',
  fromLabel: 'From',
  dateLabel: 'Date',
  subjectLabel: 'Subject',
  toLabel: 'To',
  ccLabel: 'Cc',
};

/**
 * The labels in the app language. Shared by the composer and the quick reply
 * box so a reply carries the same header whichever one sent it.
 */
export function quoteHeaderLabels(t: (key: string, fallback: string) => string): QuoteHeaderLabels {
  return {
    replyLine: t('quote_header.reply_line', 'On {date}, {from} wrote:'),
    forwardedSeparator: t('quote_header.forwarded_separator', '---------- Forwarded message ----------'),
    fromLabel: t('quote_header.from_label', 'From'),
    dateLabel: t('quote_header.date_label', 'Date'),
    subjectLabel: t('quote_header.subject_label', 'Subject'),
    toLabel: t('compose_words.forward_to_label', 'To'),
    ccLabel: t('compose_words.forward_cc_label', 'Cc'),
  };
}

export interface QuoteHeader {
  html: string;
  text: string;
  wrapInBlockquote: boolean;
}

type HeaderAddress = { email?: string; name?: string };

/** "Name <address>, address", as the forward header's From line writes one. */
function formatAddressList(list: HeaderAddress[] | undefined): string {
  return (list ?? [])
    .filter((r) => r.email)
    .map((r) => (r.name && r.name !== r.email ? `${r.name} <${r.email}>` : (r.email as string)))
    .join(', ');
}

/**
 * The To and Cc lines of a forward header, as Gmail and Outlook write them:
 * one per list that has anyone on it, for a label the caller gave. Values
 * are plain text; escape them for HTML.
 */
export function forwardRecipientLines(
  email: { to?: HeaderAddress[]; cc?: HeaderAddress[] },
  labels: { toLabel?: string; ccLabel?: string },
): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  const to = formatAddressList(email.to);
  const cc = formatAddressList(email.cc);
  if (labels.toLabel && to) lines.push({ label: labels.toLabel, value: to });
  if (labels.ccLabel && cc) lines.push({ label: labels.ccLabel, value: cc });
  return lines;
}

export interface QuoteHeaderArgs {
  mode: 'reply' | 'replyAll' | 'forward';
  email: {
    from?: { email?: string; name?: string };
    to?: HeaderAddress[];
    cc?: HeaderAddress[];
    subject?: string;
    receivedAt?: string;
  };
  timeFormat: TimeFormat;
  locale?: string;
  unknownLabel: string;
  labels?: QuoteHeaderLabels;
}

/** Locale- and 12/24h-aware date with a short weekday (webmail formatDateTime). */
export function formatQuoteDate(iso: string | undefined, timeFormat: TimeFormat, locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString(intlLocale(locale), {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: timeFormat === '12h',
    });
  } catch {
    return d.toLocaleString();
  }
}

/** "Name <email>" when both are known and distinct, else whichever exists. */
export function formatQuoteSender(
  from: { email?: string; name?: string } | undefined,
  unknownLabel: string,
): string {
  if (!from) return unknownLabel;
  if (from.name && from.email && from.name !== from.email) return `${from.name} <${from.email}>`;
  return from.email || from.name || unknownLabel;
}

function fillReplyLine(template: string, vars: { date: string; from: string }): string {
  const line = template.replace('{date}', vars.date).replace('{from}', vars.from).replace('{sender}', vars.from);
  // A missing date leaves "On , X wrote:" - collapse the dangling comma.
  return vars.date ? line : line.replace(/^\S+\s*,\s*/, '');
}

export function buildQuoteHeader(args: QuoteHeaderArgs): QuoteHeader {
  const { mode, email, timeFormat, locale, unknownLabel } = args;
  const labels = args.labels ?? DEFAULT_QUOTE_HEADER_LABELS;
  const date = formatQuoteDate(email.receivedAt, timeFormat, locale);
  const fromStrFull = formatQuoteSender(email.from, unknownLabel);
  const subject = email.subject || '';

  if (mode === 'forward') {
    const recipients = forwardRecipientLines(email, labels);
    const text = `${labels.forwardedSeparator}\n${labels.fromLabel}: ${fromStrFull}\n${labels.dateLabel}: ${date}\n${labels.subjectLabel}: ${subject}\n`
      + recipients.map((line) => `${line.label}: ${line.value}\n`).join('');
    const html = `<div>${labels.forwardedSeparator}<br>${labels.fromLabel}: ${escapeHtml(fromStrFull)}<br>${labels.dateLabel}: ${escapeHtml(date)}<br>${labels.subjectLabel}: ${escapeHtml(subject)}<br>`
      + recipients.map((line) => `${line.label}: ${escapeHtml(line.value)}<br>`).join('')
      + '<br></div>';
    return { html, text, wrapInBlockquote: false };
  }

  const text = `${fillReplyLine(labels.replyLine, { date, from: fromStrFull })}\n`;
  const html = `<div>${fillReplyLine(labels.replyLine, { date: escapeHtml(date), from: escapeHtml(fromStrFull) })}<br></div>`;
  return { html, text, wrapInBlockquote: true };
}
