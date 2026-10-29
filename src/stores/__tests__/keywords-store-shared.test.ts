import { describe, it, expect, vi, beforeEach } from 'vitest';

const { client, metadata } = vi.hoisted(() => ({
  client: { username: 'me@example.org' as string | null, serverUrl: 'https://mail.example.org', connectedAccountId: 'own' },
  metadata: vi.fn(),
}));

vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../api/bulwark-metadata', () => ({ getBulwarkMetadata: metadata }));

import { useKeywordsStore, currentTagsLogin } from '../keywords-store';

const TEAM_TAGS = { tags: { tags: { urgent: { label: 'Urgent', color: 'red' } } } };

beforeEach(() => {
  metadata.mockReset();
  client.username = 'me@example.org';
  useKeywordsStore.setState({ sharedTags: {} });
});

describe('loadSharedTags', () => {
  it("reads a group account's shared tags and stamps them with the login", async () => {
    metadata.mockResolvedValue(TEAM_TAGS);
    await useKeywordsStore.getState().loadSharedTags('team');
    expect(metadata).toHaveBeenCalledWith('team');
    const entry = useKeywordsStore.getState().sharedTags.team;
    expect(entry.tags).toEqual([{ id: 'urgent', label: 'Urgent', color: 'red' }]);
    expect(entry.login).toBe(currentTagsLogin());
  });

  it("never asks for the user's own account, and doesn't ask again while fresh", async () => {
    metadata.mockResolvedValue(TEAM_TAGS);
    await useKeywordsStore.getState().loadSharedTags('own');
    expect(metadata).not.toHaveBeenCalled();
    await useKeywordsStore.getState().loadSharedTags('team');
    await useKeywordsStore.getState().loadSharedTags('team');
    expect(metadata).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good tags when a read fails', async () => {
    metadata.mockResolvedValueOnce(TEAM_TAGS).mockResolvedValueOnce(null);
    await useKeywordsStore.getState().loadSharedTags('team');
    await useKeywordsStore.getState().loadSharedTags('team', { force: true });
    expect(useKeywordsStore.getState().sharedTags.team.tags).toHaveLength(1);
  });

  // Every list row reads its tag colours from this object: a new one on each
  // re-read re-rendered the whole list.
  it('keeps the same object when a re-read finds the same tags, and counts it as fresh', async () => {
    vi.useFakeTimers();
    try {
      metadata.mockResolvedValue(TEAM_TAGS);
      await useKeywordsStore.getState().loadSharedTags('team');
      const before = useKeywordsStore.getState().sharedTags;
      vi.advanceTimersByTime(3 * 60_000);
      await useKeywordsStore.getState().loadSharedTags('team');
      expect(metadata).toHaveBeenCalledTimes(2);
      expect(useKeywordsStore.getState().sharedTags).toBe(before);
      // The unchanged answer still counts as a fresh read.
      vi.advanceTimersByTime(60_000);
      await useKeywordsStore.getState().loadSharedTags('team');
      expect(metadata).toHaveBeenCalledTimes(2);

      metadata.mockResolvedValue({ tags: { tags: { urgent: { label: 'Now', color: 'red' } } } });
      await useKeywordsStore.getState().loadSharedTags('team', { force: true });
      expect(useKeywordsStore.getState().sharedTags).not.toBe(before);
      expect(useKeywordsStore.getState().sharedTags.team.tags[0].label).toBe('Now');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops an answer that arrives after the user switched to another login', async () => {
    let resolve!: (v: unknown) => void;
    metadata.mockReturnValue(new Promise((r) => { resolve = r; }));
    const loading = useKeywordsStore.getState().loadSharedTags('team');
    client.username = 'other@example.org';
    resolve(TEAM_TAGS);
    await loading;
    expect(useKeywordsStore.getState().sharedTags.team).toBeUndefined();
  });
});
