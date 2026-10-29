import React from 'react';
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colors } from '../theme/tokens';
import { jmapClient } from '../api/jmap-client';
import { getBulwarkMetadata } from '../api/bulwark-metadata';
import { SHARED_TAGS_KEY, mergeSharedTags, parseSharedTags } from '../lib/shared-tags';

const STORAGE_KEY = 'webmail:keywords:v1';

export type KeywordColor = keyof typeof colors.tags;

export interface KeywordDef {
  id: string;
  label: string;
  color: KeywordColor;
}

// Same ids/labels/colours as the webmail's DEFAULT_KEYWORDS
// (stores/settings-store.ts): the default tags are named after their colour,
// so a message tagged `$label:blue` on one client is the same tag on the
// other. The colour keys match the webmail's KEYWORD_PALETTE base row.
export const DEFAULT_KEYWORDS: KeywordDef[] = [
  { id: 'red',    label: 'Red',    color: 'red' },
  { id: 'orange', label: 'Orange', color: 'orange' },
  { id: 'yellow', label: 'Yellow', color: 'yellow' },
  { id: 'green',  label: 'Green',  color: 'green' },
  { id: 'blue',   label: 'Blue',   color: 'blue' },
  { id: 'purple', label: 'Purple', color: 'purple' },
  { id: 'pink',   label: 'Pink',   color: 'pink' },
];

/** The colour a tag falls back to when its definition is gone. */
export const FALLBACK_KEYWORD_COLOR: KeywordColor = 'gray';

/**
 * JMAP keyword token used on emails for a given keyword id.
 * Matches webmail convention: `$label:<id>`.
 */
export function keywordToken(id: string): string {
  return `$label:${id}`;
}

/** A group account's shared tags (lib/shared-tags.ts), as last read. */
export interface SharedTagsEntry {
  /** Server and user that read them: account ids repeat across servers. */
  login: string;
  tags: KeywordDef[];
  loadedAt: number;
}

/** Shared tags older than this are read again when a view asks for them. */
export const SHARED_TAGS_STALE_MS = 2 * 60_000;

interface KeywordsState {
  keywords: KeywordDef[];
  hydrated: boolean;
  /** Shared tag definitions of the group accounts, by JMAP account id. */
  sharedTags: Record<string, SharedTagsEntry>;
  /**
   * Read a group account's shared tags from its Inbox metadata, unless they
   * were read for this login in the last two minutes. Nothing goes out for
   * the user's own account or one that keeps no metadata (Stalwart 0.16).
   */
  loadSharedTags: (accountId: string, options?: { force?: boolean }) => Promise<void>;
  hydrate: () => Promise<void>;
  add: (kw: KeywordDef) => void;
  update: (id: string, patch: Partial<Omit<KeywordDef, 'id'>>) => void;
  remove: (id: string) => void;
  resetDefaults: () => void;
}

/** The login the JMAP client is connected as, '' before a session. */
export function currentTagsLogin(): string {
  const user = jmapClient.username;
  const server = jmapClient.serverUrl;
  return user && server ? `${server}|${user}` : '';
}

const sharedInflight = new Map<string, Promise<void>>();

function persist(keywords: KeywordDef[]): void {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(keywords)).catch((err) => {
    console.warn('[keywords-store] persist failed', err);
  });
}

export const useKeywordsStore = create<KeywordsState>((set, get) => ({
  keywords: DEFAULT_KEYWORDS,
  hydrated: false,
  sharedTags: {},

  loadSharedTags: (accountId, options) => {
    const login = currentTagsLogin();
    if (!login || !accountId || accountId === jmapClient.connectedAccountId) return Promise.resolve();
    const current = get().sharedTags[accountId];
    if (!options?.force && current?.login === login && Date.now() - current.loadedAt < SHARED_TAGS_STALE_MS) {
      return Promise.resolve();
    }
    const key = `${login}|${accountId}`;
    const running = sharedInflight.get(key);
    if (running) return running;
    const run = (async () => {
      const entries = await getBulwarkMetadata(accountId);
      // The user switched accounts meanwhile: these tags are another login's.
      if (currentTagsLogin() !== login) return;
      // A failed read (or none to make) keeps the last good tags.
      if (!entries) return;
      set((s) => ({
        sharedTags: {
          ...s.sharedTags,
          [accountId]: { login, tags: parseSharedTags(entries[SHARED_TAGS_KEY]), loadedAt: Date.now() },
        },
      }));
    })().finally(() => sharedInflight.delete(key));
    sharedInflight.set(key, run);
    return run;
  },

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as KeywordDef[];
        if (Array.isArray(parsed)) {
          set({ keywords: parsed, hydrated: true });
          return;
        }
      }
    } catch (err) {
      console.warn('[keywords-store] hydrate failed', err);
    }
    set({ hydrated: true });
  },

  add: (kw) => {
    const next = [...get().keywords, kw];
    set({ keywords: next });
    persist(next);
  },

  update: (id, patch) => {
    const next = get().keywords.map((k) => (k.id === id ? { ...k, ...patch } : k));
    set({ keywords: next });
    persist(next);
  },

  remove: (id) => {
    const next = get().keywords.filter((k) => k.id !== id);
    set({ keywords: next });
    persist(next);
  },

  resetDefaults: () => {
    set({ keywords: DEFAULT_KEYWORDS });
    persist(DEFAULT_KEYWORDS);
  },
}));

/**
 * The tag definitions for messages of a JMAP account: a group account's
 * shared tags first (read from its Inbox metadata, Stalwart 1.0), then the
 * user's own; just the user's own for their own account or before the
 * shared ones are known. `accountId` undefined means the user's own.
 */
export function useAccountKeywordDefs(accountId: string | undefined): KeywordDef[] {
  const personal = useKeywordsStore((s) => s.keywords);
  const entry = useKeywordsStore((s) => (accountId ? s.sharedTags[accountId] : undefined));
  const loadSharedTags = useKeywordsStore((s) => s.loadSharedTags);
  React.useEffect(() => {
    if (accountId) void loadSharedTags(accountId);
  }, [accountId, loadSharedTags]);
  return React.useMemo(
    () => (entry && entry.login === currentTagsLogin() ? mergeSharedTags(entry.tags, personal) : personal),
    [entry, personal],
  );
}
