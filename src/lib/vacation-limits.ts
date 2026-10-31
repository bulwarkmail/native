// Stalwart refuses a vacation subject of 512 bytes or more and a text or
// HTML body of 2048 bytes or more, answering only "Field could not be set"
// (webmail components/settings/vacation-settings.tsx).
export const STALWART_VACATION_LIMITS = { subject: 511, body: 2047 } as const;

export type VacationLimits = { subject: number; body: number };

/** The UTF-8 length of `value` in bytes. */
export function utf8Length(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Which parts of the reply as a save sends it are over the server's limits; none without limits. */
export function vacationOversize(
  reply: { subject: string; textBody: string; htmlBody: string | null },
  limits: VacationLimits | null,
): { subject: boolean; body: boolean } {
  if (!limits) return { subject: false, body: false };
  return {
    subject: utf8Length(reply.subject) > limits.subject,
    body: utf8Length(reply.textBody) > limits.body
      || (reply.htmlBody !== null && utf8Length(reply.htmlBody) > limits.body),
  };
}
