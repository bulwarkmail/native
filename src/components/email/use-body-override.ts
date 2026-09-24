import React from 'react';
import type { Email as ParsedEmail } from 'postal-mime';
import type { Attachment, Email } from '../../api/types';
import { pickEmailBody } from '../../lib/email-body';
import { fetchBlobBytes, bytesToBase64 } from '../../lib/email-export';
import { isRfc822Attachment, isTnefAttachment } from '../../lib/attachment-display';
import { parseTnef } from '../../lib/tnef';
import { sniffImageMime } from '../../lib/email-html';

/** A part extracted client-side (TNEF / embedded message) - bytes, not a blob. */
export interface ExtractedAttachment {
  name: string;
  type: string;
  size: number;
  bytes: Uint8Array;
}

export interface BodyOverrideState {
  /** Body to render instead of the message's own, when one was extracted. */
  override: { html?: string | null; text?: string | null } | null;
  /** Extra chips for extracted parts. */
  extracted: ExtractedAttachment[];
  /** winmail.dat was unpacked (its chip is hidden). */
  tnefUnpacked: boolean;
  loading: boolean;
}

const EMPTY: BodyOverrideState = { override: null, extracted: [], tnefUnpacked: false, loading: false };
const MAX_UNWRAP_BYTES = 25 * 1024 * 1024;

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

async function parseMessage(bytes: Uint8Array): Promise<ParsedEmail> {
  const { default: PostalMime } = await import('postal-mime');
  return PostalMime.parse(bytes, { attachmentEncoding: 'arraybuffer' });
}

/**
 * Parse an embedded message/rfc822 part with postal-mime and inline its cid
 * images as data: URIs (they are not JMAP blobs, so the body view can't
 * fetch them).
 */
export async function unwrapEmbeddedMessage(bytes: Uint8Array): Promise<UnwrappedMessage> {
  return unwrapParsed(await parseMessage(bytes));
}

interface UnwrappedMessage {
  html: string | null;
  text: string | null;
  attachments: ExtractedAttachment[];
}

/** What the in-app preview shows for an .eml file or message/rfc822 part. */
export interface EmlPreview {
  subject?: string;
  from?: string;
  date?: string;
  html: string | null;
  text: string | null;
}

/** Parse a message once for the preview: its unwrapped body plus the header lines shown above it. */
export async function emlPreviewFromBytes(bytes: Uint8Array): Promise<EmlPreview> {
  const parsed = await parseMessage(bytes);
  const { html, text } = unwrapParsed(parsed);
  const from = parsed.from && 'address' in parsed.from
    ? `${parsed.from.name ? `${parsed.from.name} ` : ''}<${parsed.from.address}>`
    : parsed.from?.name;
  return { subject: parsed.subject, from, date: parsed.date, html, text };
}

function unwrapParsed(parsed: ParsedEmail): UnwrappedMessage {
  let html = parsed.html ?? null;
  const text = parsed.text ?? null;
  const attachments: ExtractedAttachment[] = [];
  for (const att of parsed.attachments ?? []) {
    const data = toBytes(att.content);
    const cid = att.contentId?.replace(/^<|>$/g, '');
    if (cid && html && html.includes(`cid:${cid}`)) {
      const mime = sniffImageMime(data, att.mimeType);
      html = html.split(`cid:${cid}`).join(`data:${mime};base64,${bytesToBase64(data)}`);
      if (att.disposition === 'inline') continue;
    }
    attachments.push({
      name: att.filename || 'attachment',
      type: att.mimeType || 'application/octet-stream',
      size: data.byteLength,
      bytes: data,
    });
  }
  return { html, text, attachments };
}

/**
 * Two client-side unwraps the webmail does before rendering:
 *  - Outlook "forward as attachment": the outer message is an empty envelope
 *    around a message/rfc822 part - render the embedded message's body and
 *    list its attachments (the .eml chip stays, it is a real attachment);
 *  - TNEF winmail.dat: parse the container for the body and the files inside
 *    it, and hide the opaque winmail.dat chip.
 */
export function useBodyOverride(email: Email, jmapAccountId?: string): BodyOverrideState {
  const [state, setState] = React.useState<BodyOverrideState>(EMPTY);

  const picked = React.useMemo(() => pickEmailBody(email), [email]);
  const bodyEmpty = !picked.html && !(picked.text && picked.text.trim());
  const rfc822 = React.useMemo(
    () => (bodyEmpty ? (email.attachments ?? []).find((a): a is Attachment => isRfc822Attachment(a)) : undefined),
    [email.attachments, bodyEmpty],
  );
  const tnef = React.useMemo(
    () => (email.attachments ?? []).find((a) => isTnefAttachment(a.name, a.type)),
    [email.attachments],
  );

  React.useEffect(() => {
    let cancelled = false;
    if (!rfc822 && !tnef) {
      setState(EMPTY);
      return;
    }
    setState({ ...EMPTY, loading: true });
    void (async () => {
      try {
        if (tnef) {
          if ((tnef.size ?? 0) > MAX_UNWRAP_BYTES) throw new Error('winmail.dat too large');
          const bytes = await fetchBlobBytes(tnef.blobId, tnef.name, tnef.type, jmapAccountId);
          const res = parseTnef(bytes);
          if (cancelled) return;
          const extracted = res.attachments.map((a) => ({
            name: a.name, type: a.mimeType, size: a.data.byteLength, bytes: a.data,
          }));
          const unpacked = !!(res.htmlBody || res.body || extracted.length);
          setState({
            override: bodyEmpty && (res.htmlBody || res.body) ? { html: res.htmlBody, text: res.body } : null,
            extracted,
            tnefUnpacked: unpacked,
            loading: false,
          });
          return;
        }
        if (rfc822) {
          if ((rfc822.size ?? 0) > MAX_UNWRAP_BYTES) throw new Error('embedded message too large');
          const bytes = await fetchBlobBytes(rfc822.blobId, rfc822.name, rfc822.type, jmapAccountId);
          const res = await unwrapEmbeddedMessage(bytes);
          if (cancelled) return;
          setState({
            override: res.html || res.text ? { html: res.html, text: res.text } : null,
            extracted: res.attachments,
            tnefUnpacked: false,
            loading: false,
          });
        }
      } catch (err) {
        console.warn('[reader] body unwrap failed', err);
        if (!cancelled) setState(EMPTY);
      }
    })();
    return () => { cancelled = true; };
  }, [rfc822, tnef, bodyEmpty, jmapAccountId]);

  return state;
}
