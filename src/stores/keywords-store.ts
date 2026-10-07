import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colors } from '../theme/tokens';
import { suggestKeywordColor } from '../lib/keyword-discovery';

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

/**
 * The colour of a tag whose definition is gone (set by another client): a
 * stable one picked from its id, as the webmail does, so different unknown
 * tags are told apart. Not influenced by the other definitions, so it never
 * changes when those do.
 */
export function unknownKeywordColor(id: string): KeywordColor {
  return suggestKeywordColor(id);
}

/**
 * JMAP keyword token used on emails for a given keyword id.
 * Matches webmail convention: `$label:<id>`.
 */
export function keywordToken(id: string): string {
  return `$label:${id}`;
}

interface KeywordsState {
  keywords: KeywordDef[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  add: (kw: KeywordDef) => void;
  update: (id: string, patch: Partial<Omit<KeywordDef, 'id'>>) => void;
  remove: (id: string) => void;
  resetDefaults: () => void;
}

function persist(keywords: KeywordDef[]): void {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(keywords)).catch((err) => {
    console.warn('[keywords-store] persist failed', err);
  });
}

export const useKeywordsStore = create<KeywordsState>((set, get) => ({
  keywords: DEFAULT_KEYWORDS,
  hydrated: false,

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
