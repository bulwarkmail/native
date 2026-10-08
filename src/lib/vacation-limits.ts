// Stalwart refuses a vacation subject of 512 bytes or more and a text or HTML
// body of 2048 bytes or more, answering only "Field could not be set." The
// limits apply only to a Stalwart account (urn:stalwart:jmap).
export const STALWART_VACATION_LIMITS = { subject: 511, body: 2047 };

export type VacationLimits = typeof STALWART_VACATION_LIMITS;

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function vacationOversize(
  fields: { subject: string; textBody: string; html: string | null },
  limits: VacationLimits | null,
): { subject: boolean; body: boolean } {
  if (!limits) return { subject: false, body: false };
  return {
    subject: utf8Length(fields.subject) > limits.subject,
    body:
      utf8Length(fields.textBody) > limits.body ||
      (fields.html !== null && utf8Length(fields.html) > limits.body),
  };
}
