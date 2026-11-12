// What the composer asks about before a message goes out, in one question
// (webmail components/email/send-warnings-dialog.tsx and email-composer.tsx
// handleSend). Several Alerts in a row asked about each in turn. The
// organisation's "Send outside your organisation?" (webmail
// external-recipient-confirm.tsx, a dialog of its own after these checks)
// joins the same sheet, last.

import type { ExternalRecipient } from './external-mail';

/** Something the composer asks about before a message goes out. */
export type SendWarning =
  | { kind: 'subject' }
  | { kind: 'placeholders'; matches: string[] }
  | { kind: 'attachment'; keyword: string }
  | { kind: 'external'; recipients: ExternalRecipient[] };

/** The warnings that can be switched off in Settings (subject and placeholders). */
const HAS_SETTING = new Set<SendWarning['kind']>(['subject', 'placeholders']);

/** How many placeholders the question lists before "and N more". */
export const SHOWN_PLACEHOLDERS = 5;

export interface SendWarningInput {
  subject: string;
  /** "Send without a subject?" is on and wasn't answered for this message. */
  askSubject: boolean;
  /** The unfilled placeholders; null when the warning is off. */
  placeholders: string[] | null;
  /** Placeholders already let through with "Send anyway". */
  confirmedPlaceholders: ReadonlySet<string>;
  /** The keyword of the attachment reminder, when it fires. */
  attachmentKeyword?: string;
  /** Recipients outside the organisation, when its recipient warning is on. */
  externalRecipients?: ExternalRecipient[];
}

/** The warnings for one Send, in the order the composer checks them. */
export function collectSendWarnings(input: SendWarningInput): SendWarning[] {
  const warnings: SendWarning[] = [];
  if (input.askSubject && !input.subject.trim()) warnings.push({ kind: 'subject' });
  const found = input.placeholders ?? [];
  if (found.some((p) => !input.confirmedPlaceholders.has(p))) warnings.push({ kind: 'placeholders', matches: found });
  if (input.attachmentKeyword) warnings.push({ kind: 'attachment', keyword: input.attachmentKeyword });
  if (input.externalRecipients?.length) warnings.push({ kind: 'external', recipients: input.externalRecipients });
  return warnings;
}

type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string;

export interface SendWarningsContent {
  title: string;
  description?: string;
  /** One line per warning when there are several. */
  items: { kind: SendWarning['kind']; text: string; matches?: string[]; recipients?: ExternalRecipient[] }[];
  /** The placeholders of a single placeholder warning. */
  matches?: string[];
  /** The recipients of a single external-recipient warning. */
  recipients?: ExternalRecipient[];
  backLabel: string;
  sendLabel: string;
  /** The box under a single warning that has a setting. */
  dontAskAgainLabel?: string;
}

/**
 * The text of the question: a single warning keeps its own title and text,
 * several are listed with one "Send anyway". Before Schedule send the
 * button says "Schedule anyway".
 */
export function sendWarningsContent(warnings: SendWarning[], t: Translate, scheduling = false): SendWarningsContent {
  const single = warnings.length === 1 ? warnings[0] : null;
  let content: SendWarningsContent;
  if (single?.kind === 'subject') {
    content = {
      title: t('email_composer.empty_subject.title', 'Send without a subject?'),
      description: t('email_composer.empty_subject.message', 'This message has no subject. Send it anyway?'),
      items: [],
      backLabel: t('email_composer.empty_subject.back', 'Back to editing'),
      sendLabel: t('email_composer.empty_subject.send_anyway', 'Send anyway'),
      dontAskAgainLabel: t('email_composer.empty_subject.dont_ask_again', "Don't ask again"),
    };
  } else if (single?.kind === 'placeholders') {
    content = {
      title: t('email_composer.placeholder_warning.title', 'Check placeholders?'),
      description: t(
        'email_composer.placeholder_warning.message',
        'Your message has placeholder text that recipients will see. Do you want to edit it before sending?',
      ),
      items: [],
      matches: single.matches,
      backLabel: t('email_composer.placeholder_warning.back', 'Back to editing'),
      sendLabel: t('email_composer.placeholder_warning.send_anyway', 'Send anyway'),
      dontAskAgainLabel: t('email_composer.placeholder_warning.dont_ask_again', "Don't ask again"),
    };
  } else if (single?.kind === 'attachment') {
    content = {
      title: t('email_composer.forgot_attachment.title', 'Did you forget an attachment?'),
      description: t(
        'email_composer.forgot_attachment.message',
        'Your message mentions "{keyword}" but no file is attached. Send anyway?',
        { keyword: single.keyword },
      ),
      items: [],
      backLabel: t('email_composer.forgot_attachment.back', 'Back to editing'),
      sendLabel: t('email_composer.forgot_attachment.send_anyway', 'Send anyway'),
    };
  } else if (single?.kind === 'external') {
    content = {
      title: t('external_mail.confirm_title', 'Send outside your organisation?'),
      description: t(
        'external_mail.confirm_message',
        '{count, plural, one {This recipient is} other {These # recipients are}} outside your organisation. Send only if you mean to.',
        { count: single.recipients.length },
      ),
      items: [],
      recipients: single.recipients,
      backLabel: t('external_mail.back', 'Back'),
      sendLabel: t('external_mail.send_anyway', 'Send anyway'),
    };
  } else {
    content = {
      title: scheduling
        ? t('compose_send.schedule_warnings_title', 'Schedule this message anyway?')
        : t('compose_send.warnings_title', 'Send this message anyway?'),
      items: warnings.map((w) => {
        if (w.kind === 'subject') return { kind: w.kind, text: t('compose_send.warning_subject', 'No subject') };
        if (w.kind === 'attachment') {
          return {
            kind: w.kind,
            text: t('compose_send.warning_attachment', 'Mentions "{keyword}", but no file is attached', { keyword: w.keyword }),
          };
        }
        if (w.kind === 'external') {
          return {
            kind: w.kind,
            text: t(
              'compose_send.warning_external',
              '{count, plural, one {A recipient is} other {# recipients are}} outside your organisation:',
              { count: w.recipients.length },
            ),
            recipients: w.recipients,
          };
        }
        return {
          kind: w.kind,
          text: t('compose_send.warning_placeholders', 'Placeholder text that recipients will see:'),
          matches: w.matches,
        };
      }),
      backLabel: t('compose_send.back', 'Back to editing'),
      sendLabel: t('compose_send.send_anyway', 'Send anyway'),
    };
  }
  if (scheduling) content.sendLabel = t('compose_send.schedule_anyway', 'Schedule anyway');
  if (!single || !HAS_SETTING.has(single.kind)) delete content.dontAskAgainLabel;
  return content;
}

export interface SendWarningsAnswer {
  /** The subject warning was let through for this message. */
  subjectConfirmed: boolean;
  /** Placeholders let through for this message. */
  placeholders: string[];
  /** Settings to switch off ("Don't ask again" under a single warning). */
  switchOff: ('emptySubjectWarningEnabled' | 'placeholderWarningEnabled')[];
}

/** What "Send anyway" lets through, and what "Don't ask again" switches off. */
export function answerSendWarnings(warnings: SendWarning[], dontAskAgain: boolean): SendWarningsAnswer {
  const answer: SendWarningsAnswer = { subjectConfirmed: false, placeholders: [], switchOff: [] };
  const single = warnings.length === 1;
  for (const w of warnings) {
    if (w.kind === 'subject') {
      answer.subjectConfirmed = true;
      if (dontAskAgain && single) answer.switchOff.push('emptySubjectWarningEnabled');
    } else if (w.kind === 'placeholders') {
      answer.placeholders.push(...w.matches);
      if (dontAskAgain && single) answer.switchOff.push('placeholderWarningEnabled');
    }
  }
  return answer;
}
