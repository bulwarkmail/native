import type { VacationForward } from './types';
import { isPeriodBoundary } from './period';

/**
 * The webmail's address check (lib/validation.ts isValidEmail), copied as it
 * is. Forwarding counts as Bulwark's only when both clients read its address
 * the same way: the app's own check trims and takes IDN domains, so with it
 * the app could write a forward the webmail then treats as hand-edited.
 */
function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  if (/[\r\n\0<>]/.test(email)) return false;
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!emailRegex.test(email)) return false;
  const [localPart, domain] = email.split('@');
  if (localPart.length > 64) return false;
  if (domain.length > 255) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  if (domain.includes('..')) return false;
  return true;
}

/**
 * Forwarding from the vacation card (see VacationForward). The generator
 * writes it as its own block after the vacation include, marked by this
 * comment; the parser knows the block by it and leaves it to the generator.
 */
export const VACATION_FORWARD_MARKER = '# Vacation forwarding';

/**
 * The marker as the parser looks for it in a block: the whole line, so a
 * comment of someone's own that only begins like it is not taken for it.
 */
export const VACATION_FORWARD_MARKER_RE = /^[ \t]*# Vacation forwarding[ \t]*$/m;

/** Whether `value` is forwarding Bulwark can write back as it reads. */
export function isValidVacationForward(value: unknown): value is VacationForward {
  if (!value || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  if (typeof f.enabled !== 'boolean' || typeof f.keepCopy !== 'boolean') return false;
  if (typeof f.to !== 'string' || !isValidEmail(f.to)) return false;
  if (f.activeFrom !== undefined && !isPeriodBoundary(f.activeFrom)) return false;
  if (f.activeUntil !== undefined && !isPeriodBoundary(f.activeUntil)) return false;
  return true;
}

/**
 * The forwarding with the vacation's period, whatever period it had: it runs
 * while the vacation does (an empty date leaves that end open).
 */
export function withVacationPeriod(
  forward: Pick<VacationForward, 'enabled' | 'to' | 'keepCopy'>,
  period: { from: string | null; until: string | null },
): VacationForward {
  return {
    enabled: forward.enabled,
    to: forward.to,
    keepCopy: forward.keepCopy,
    ...(period.from ? { activeFrom: period.from } : {}),
    ...(period.until ? { activeUntil: period.until } : {}),
  };
}

/** The fields Bulwark stores, in a fixed order. */
export function normalizeVacationForward(forward: VacationForward): VacationForward {
  return {
    enabled: forward.enabled,
    to: forward.to,
    keepCopy: forward.keepCopy,
    ...(forward.activeFrom !== undefined ? { activeFrom: forward.activeFrom } : {}),
    ...(forward.activeUntil !== undefined ? { activeUntil: forward.activeUntil } : {}),
  };
}
