export interface RowLabelParts {
  sender: string;
  subject: string;
  time: string;
  /** Already-translated phrases, present only when they apply. */
  unread?: string;
  pinned?: string;
  replied?: string;
  forwarded?: string;
  attachment?: string;
  flagged?: string;
  /** "N messages", for a conversation. */
  threadCount?: string;
  tags?: readonly string[];
}

/**
 * One screen-reader label for a mail list row: the order a sighted reader
 * takes it in (who, what, when), then the states the row shows only as icons.
 */
export function buildRowLabel(p: RowLabelParts): string {
  return [
    p.unread, p.sender, p.subject, p.time, p.threadCount,
    p.pinned, p.flagged, p.replied, p.forwarded, p.attachment, ...(p.tags ?? []),
  ]
    .filter((part): part is string => !!part)
    .join(', ');
}
