import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colors } from '../theme/tokens';

const STORAGE_KEY = 'webmail:keywords:v1';

export type KeywordColor = keyof typeof colors.tags;

export interface KeywordDef {
  id: string;
  label: string;
  color: KeywordColor;
}

const DEFAULT_KEYWORDS: KeywordDef[] = [
  { id: 'important', label: 'Important', color: 'red' },
  { id: 'work',      label: 'Work',      color: 'blue' },
  { id: 'personal',  label: 'Personal',  color: 'green' },
  { id: 'todo',      label: 'Todo',      color: 'amber' },
];

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
