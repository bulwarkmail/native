import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxCallsInRequest: vi.fn(() => 16),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

import { jmapClient } from '../jmap-client';
import { getFullEmail, getFullEmails, saveDraftVersion } from '../email';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

// A draft with an inline image as Stalwart 1.0.0 returns it (measured
// 2026-10-29): the image sits in mixed next to the alternative, so it is in
// textBody and htmlBody but not in `attachments`.
const IMAGE = { partId: '4', blobId: 'b-img', type: 'image/png', disposition: 'inline', cid: 'img1@live.test', name: 'img1.png', size: 70 };
const on10 = {
  id: 'd1',
  attachments: [],
  textBody: [{ partId: '2', blobId: 'b-text', type: 'text/plain' }, IMAGE],
  htmlBody: [{ partId: '3', blobId: 'b-html', type: 'text/html' }, IMAGE],
};
// The same message on 0.16.27: the image is in all three lists.
const on016 = { ...on10, attachments: [IMAGE] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('inline images that Stalwart 1.0 lists only in the body lists', () => {
  it('getFullEmail takes them into attachments', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['Email/get', { list: [on10], notFound: [] }, '0']] });
    const email = await getFullEmail('d1');
    expect(email.attachments).toEqual([IMAGE]);
  });

  it('getFullEmails does too, and lists a 0.16 part once', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Email/get', { list: [on10, { ...on016, id: 'd2' }], notFound: [] }, '0']],
    });
    const [a, b] = await getFullEmails(['d1', 'd2']);
    expect(a.attachments?.map((x) => x.cid)).toEqual(['img1@live.test']);
    expect(b.attachments).toHaveLength(1);
  });

  it('saveDraftVersion reads the new version\'s inline part back from the body lists', async () => {
    mockRequest.mockImplementation(async (calls: Array<[string, Record<string, unknown>, string]>) => {
      const get = calls.find(([m]) => m === 'Email/get')![1];
      expect(get.properties).toEqual(expect.arrayContaining(['attachments', 'textBody', 'htmlBody']));
      return {
        methodResponses: [
          ['Email/set', { created: { draft: { id: 'd1' } } }, '0'],
          ['Email/get', { list: [on10] }, '1'],
        ],
      };
    });
    const saved = await saveDraftVersion({
      from: [{ email: 'me@example.org' }], to: [], subject: 's',
      htmlBody: '<p><img src="cid:img1@live.test"></p>',
      attachments: [{ blobId: 'up-1', type: 'image/png', name: 'img1.png', disposition: 'inline', cid: 'img1@live.test' }],
    }, 'drafts');
    expect(saved.attachments.map((a) => a.blobId)).toEqual(['b-img']);
  });
});
