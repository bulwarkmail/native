import { describe, it, expect } from 'vitest';
import { isReportPart } from '../attachment-display';
import { realAttachments } from '../list-attachments';
import type { Attachment } from '../../api/types';

// A bounce's delivery status and a read receipt's disposition showed as
// attachment chips in the list (the reader already hid them), and the RFC
// 6533 `global-` forms counted as real files everywhere (webmail 8a09ba573).

const part = (type: string, name: string): Attachment => ({ blobId: `b-${name}`, type, name, size: 1 } as Attachment);

describe('report parts in list chips', () => {
  it('counts the global- forms as report parts', () => {
    expect(isReportPart('message/global-delivery-status')).toBe(true);
    expect(isReportPart('message/global-disposition-notification')).toBe(true);
    expect(isReportPart('Message/Delivery-Status; charset=utf-8')).toBe(true);
    expect(isReportPart('message/rfc822')).toBe(false);
  });

  it('leaves report parts out of the list chips', () => {
    const parts = [
      part('message/delivery-status', 'details.txt'),
      part('message/global-disposition-notification', 'receipt'),
      part('application/pdf', 'invoice.pdf'),
    ];
    expect(realAttachments(parts).map((a) => a.name)).toEqual(['invoice.pdf']);
  });
});
