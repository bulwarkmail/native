/**
 * Message priority set in the composer (webmail #970, lib/message-priority.ts).
 *
 * Clients disagree on which header carries it: Outlook reads Importance
 * (RFC 4021), Thunderbird and most others read the de-facto X-Priority
 * (1 highest ... 5 lowest). Both are written so the hint survives either
 * way. Priority (RFC 4021, MIXER) is left out: it is meant to steer
 * transmission, not display. Normal writes nothing, so ordinary mail is
 * unchanged.
 */
export type MessagePriority = 'high' | 'normal' | 'low';

export const MESSAGE_PRIORITIES: readonly MessagePriority[] = ['high', 'normal', 'low'];

/** JMAP Email/set create properties (RFC 8621 §4.1.3) for a priority. */
export function messagePriorityHeaders(priority: MessagePriority | undefined): Record<string, string> {
  if (priority === 'high') {
    return {
      'header:X-Priority:asText': '1 (Highest)',
      'header:Importance:asText': 'high',
    };
  }
  if (priority === 'low') {
    return {
      'header:X-Priority:asText': '5 (Lowest)',
      'header:Importance:asText': 'low',
    };
  }
  return {};
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const header of headers) {
    if (header?.name?.toLowerCase() !== lower) continue;
    const value = typeof header.value === 'string' ? header.value.trim() : '';
    if (value) return value;
  }
  return undefined;
}

/**
 * The priority a message's raw headers (JMAP `headers`) carry, for a
 * re-opened draft. X-Priority wins over Importance; 1-2 is high, 4-5 low,
 * anything else normal.
 */
export function messagePriorityFromHeaders(
  headers: Array<{ name: string; value: string }> | undefined | null,
): MessagePriority {
  if (!Array.isArray(headers)) return 'normal';
  const xPriority = headerValue(headers, 'X-Priority');
  const level = xPriority ? Number.parseInt(xPriority, 10) : NaN;
  if (level === 1 || level === 2) return 'high';
  if (level === 4 || level === 5) return 'low';
  if (!Number.isNaN(level)) return 'normal';
  const importance = headerValue(headers, 'Importance')?.toLowerCase();
  if (importance === 'high') return 'high';
  if (importance === 'low') return 'low';
  return 'normal';
}
