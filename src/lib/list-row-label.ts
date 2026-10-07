export interface RowLabelParts {
  sender: string;
  subject: string;
  time: string;
  /** Already-translated phrases, present only when they apply. */
  unread?: string;
  attachment?: string;
  flagged?: string;
}

/**
 * One screen-reader label for a mail list row: the order a sighted reader
 * takes it in (who, what, when), then the states the row shows only as icons.
 */
export function buildRowLabel(p: RowLabelParts): string {
  return [p.unread, p.sender, p.subject, p.time, p.attachment, p.flagged]
    .filter((part): part is string => !!part)
    .join(', ');
}
