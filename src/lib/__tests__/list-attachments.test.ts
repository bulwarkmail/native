import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentKind, realAttachments, requestListAttachments, resetListAttachmentsForTests,
  shortAttachmentName, type FetchListAttachments,
} from '../list-attachments';
import type { Attachment } from '../../api/types';

function att(over: Partial<Attachment> = {}): Attachment {
  return { blobId: 'b1', size: 100, type: 'application/pdf', name: 'doc.pdf', ...over };
}

describe('realAttachments', () => {
  it('returns nothing when the message has no attachments', () => {
    expect(realAttachments(undefined)).toEqual([]);
    expect(realAttachments([])).toEqual([]);
  });

  it('drops inline parts and Content-ID references', () => {
    const kept = att({ name: 'invoice.pdf' });
    expect(realAttachments([
      kept,
      att({ blobId: 'b2', name: 'image001.png', type: 'image/png', disposition: 'inline' }),
      // Outlook signature images arrive as cid: references without a disposition.
      att({ blobId: 'b3', name: 'image002.png', type: 'image/png', cid: 'image002.png@01DD' }),
    ])).toEqual([kept]);
  });

  it('drops parts with no filename', () => {
    expect(realAttachments([att({ name: undefined })])).toEqual([]);
  });
});

describe('chip labels', () => {
  it('keeps the extension when shortening a long name', () => {
    expect(shortAttachmentName('short.pdf')).toBe('short.pdf');
    expect(shortAttachmentName('Quarterly report final v3.xlsx')).toBe('Quarterly re….xlsx');
    expect(shortAttachmentName('averyveryverylongnamewithoutextension')).toHaveLength(18);
  });

  it('classifies by type and name', () => {
    expect(attachmentKind('image/png', 'a.png')).toBe('image');
    expect(attachmentKind('application/pdf', 'a.pdf')).toBe('pdf');
    expect(attachmentKind('application/octet-stream', 'data.csv')).toBe('sheet');
    expect(attachmentKind('application/zip', 'a.zip')).toBe('archive');
    expect(attachmentKind('application/msword', 'a.doc')).toBe('document');
    expect(attachmentKind('application/octet-stream', 'blob.bin')).toBe('other');
  });
});

describe('requestListAttachments', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    resetListAttachmentsForTests();
    vi.useRealTimers();
  });

  const pdf = (id: string) => att({ blobId: `b-${id}`, name: `${id}.pdf` });

  function fakeFetch(fail = false) {
    return vi.fn<FetchListAttachments>(async (ids) => {
      if (fail) throw new Error('boom');
      return new Map(ids.filter((id) => id !== 'gone').map((id) => [id, [pdf(id)]]));
    });
  }

  it('coalesces rows that render together into one request', async () => {
    const fetch = fakeFetch();
    const a = vi.fn();
    const b = vi.fn();
    requestListAttachments('acc', fetch, 'a', a);
    requestListAttachments('acc', fetch, 'b', b);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(['a', 'b']);
    expect(a).toHaveBeenCalledWith([pdf('a')]);
    expect(b).toHaveBeenCalledWith([pdf('b')]);
  });

  it('answers a row rendered again from the cache, synchronously', async () => {
    const fetch = fakeFetch();
    requestListAttachments('acc', fetch, 'a', vi.fn());
    await vi.runAllTimersAsync();
    const again = vi.fn();
    requestListAttachments('acc', fetch, 'a', again);
    expect(again).toHaveBeenCalledWith([pdf('a')]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('remembers ids the server did not return as having no parts', async () => {
    const fetch = fakeFetch();
    const onLoad = vi.fn();
    requestListAttachments('acc', fetch, 'gone', onLoad);
    await vi.runAllTimersAsync();
    expect(onLoad).toHaveBeenCalledWith([]);
    requestListAttachments('acc', fetch, 'gone', vi.fn());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('drops a row scrolled away before the request goes out', async () => {
    const fetch = fakeFetch();
    const cancel = requestListAttachments('acc', fetch, 'a', vi.fn());
    requestListAttachments('acc', fetch, 'b', vi.fn());
    cancel();
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledWith(['b']);
  });

  it('joins a request already in flight instead of asking again', async () => {
    let release!: () => void;
    const fetch = vi.fn<FetchListAttachments>(() => new Promise((resolve) => {
      release = () => resolve(new Map([['a', [pdf('a')]]]));
    }));
    const first = vi.fn();
    const second = vi.fn();
    requestListAttachments('acc', fetch, 'a', first);
    await vi.advanceTimersByTimeAsync(100);
    requestListAttachments('acc', fetch, 'a', second);
    await vi.advanceTimersByTimeAsync(100);
    release();
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith([pdf('a')]);
    expect(second).toHaveBeenCalledWith([pdf('a')]);
  });

  it('keeps accounts apart', async () => {
    const own = fakeFetch();
    const shared = fakeFetch();
    requestListAttachments('me', own, 'a', vi.fn());
    requestListAttachments('team', shared, 'a', vi.fn());
    await vi.runAllTimersAsync();
    expect(own).toHaveBeenCalledWith(['a']);
    expect(shared).toHaveBeenCalledWith(['a']);
  });

  it('does not cache a failure, so the next render retries', async () => {
    const fetch = fakeFetch(true);
    const onLoad = vi.fn();
    requestListAttachments('acc', fetch, 'a', onLoad);
    await vi.runAllTimersAsync();
    expect(onLoad).not.toHaveBeenCalled();
    requestListAttachments('acc', fetch, 'a', onLoad);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
