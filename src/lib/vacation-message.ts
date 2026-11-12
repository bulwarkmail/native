// The out-of-office message (webmail components/settings/vacation-settings.tsx):
// a reply with nothing written yet starts with real text in the user's
// language, and an empty message never goes live.
import { htmlToPlainText } from './compose-html';

function hasReadableText(html: string | null | undefined): boolean {
  return !!html && !!htmlToPlainText(html).trim();
}

/** A reply the server holds with nothing in it: off, no subject, no message. */
export function isBlankReply(stored: {
  isEnabled: boolean; subject: string; textBody: string; htmlBody?: string | null;
}): boolean {
  return !stored.isEnabled && !stored.subject.trim() && !stored.textBody.trim() && !hasReadableText(stored.htmlBody);
}

/** The form's message has no text: the plain part is empty and so is the formatted one, when on. */
export function vacationMessageEmpty(body: string, htmlEnabled: boolean, htmlBody: string): boolean {
  return !body.trim() && !(htmlEnabled && hasReadableText(htmlBody));
}

/** Whether a save may go out: a reply that is on needs a message. */
export function vacationMessageBlocksSave(enabled: boolean, body: string, htmlEnabled: boolean, htmlBody: string): boolean {
  return enabled && vacationMessageEmpty(body, htmlEnabled, htmlBody);
}
