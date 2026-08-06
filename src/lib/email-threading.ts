/**
 * RFC 5322 §3.6.4 threading headers for replies.
 *
 * The JMAP `Email` id (`gos2aabtux`) is a server-local handle — it is NOT the
 * RFC msg-id. Putting it in In-Reply-To/References breaks the conversation for
 * every downstream client, including the account's own server: Stalwart hashes
 * the referenced msg-ids at ingest time, finds nothing that matches, and files
 * the reply under a brand-new thread.
 *
 * `messageId` / `references` come back from JMAP as bare ids (no angle
 * brackets, RFC 8621 §4.1.2.3); the wire headers need them bracketed.
 */

export interface ParentThreadingInfo {
  messageId?: string[];
  references?: string[];
}

export interface ReplyThreadingHeaders {
  /** In-Reply-To header value, e.g. `<abc@host>` */
  inReplyTo: string;
  /** References header value: ancestors then parent, space separated */
  references: string;
}

function stripBrackets(id: string): string {
  return id.trim().replace(/^<|>$/g, '');
}

export function computeReplyThreadingHeaders(
  parent: ParentThreadingInfo | undefined,
): ReplyThreadingHeaders | undefined {
  const parentId = parent?.messageId?.map(stripBrackets).find(Boolean);
  if (!parentId) return undefined;

  const ancestors = (parent?.references ?? []).map(stripBrackets).filter(Boolean);

  // De-dupe while preserving order; the parent's id closes the chain.
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const id of [...ancestors, parentId]) {
    if (seen.has(id)) continue;
    seen.add(id);
    chain.push(id);
  }

  return {
    inReplyTo: `<${parentId}>`,
    references: chain.map((id) => `<${id}>`).join(' '),
  };
}
