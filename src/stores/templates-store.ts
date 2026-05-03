// Mobile-side templates store. Mirrors the webmail's `template-store` but
// keeps the surface minimal — categories, defaults, placeholders, and the
// favourite/recent tracking are not yet exposed in the mobile UI. We persist
// the same shape so an export from one platform imports cleanly into the
// other.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  category: string;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
}

const STORAGE_KEY = 'webmail:templates:v1';

interface TemplatesState {
  templates: EmailTemplate[];
  hydrated: boolean;

  hydrate: () => Promise<void>;
  addTemplate: (data: Pick<EmailTemplate, 'name' | 'subject' | 'body'> & Partial<Pick<EmailTemplate, 'category' | 'isFavorite'>>) => EmailTemplate;
  updateTemplate: (id: string, updates: Partial<Omit<EmailTemplate, 'id' | 'createdAt'>>) => void;
  deleteTemplate: (id: string) => void;
  exportAll: () => string;
  importTemplates: (json: string) => { count: number; error?: string };
}

function persist(state: EmailTemplate[]): void {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ templates: state })).catch((err) => {
    console.warn('[templates-store] persist failed', err);
  });
}

function genId(): string {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useTemplatesStore = create<TemplatesState>((set, get) => ({
  templates: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { templates?: EmailTemplate[] };
        if (Array.isArray(parsed.templates)) {
          set({ templates: parsed.templates, hydrated: true });
          return;
        }
      }
    } catch (err) {
      console.warn('[templates-store] hydrate failed', err);
    }
    set({ hydrated: true });
  },

  addTemplate: (data) => {
    const now = new Date().toISOString();
    const template: EmailTemplate = {
      id: genId(),
      name: data.name,
      subject: data.subject,
      body: data.body,
      category: data.category ?? '',
      isFavorite: data.isFavorite ?? false,
      createdAt: now,
      updatedAt: now,
    };
    const next = [...get().templates, template];
    set({ templates: next });
    persist(next);
    return template;
  },

  updateTemplate: (id, updates) => {
    const next = get().templates.map((t) =>
      t.id === id ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t,
    );
    set({ templates: next });
    persist(next);
  },

  deleteTemplate: (id) => {
    const next = get().templates.filter((t) => t.id !== id);
    set({ templates: next });
    persist(next);
  },

  exportAll: () => {
    return JSON.stringify({ version: 1, templates: get().templates }, null, 2);
  },

  importTemplates: (json) => {
    try {
      const parsed = JSON.parse(json) as { templates?: unknown };
      if (!Array.isArray(parsed.templates)) {
        return { count: 0, error: 'Invalid template file: expected `templates` array' };
      }
      const incoming: EmailTemplate[] = [];
      for (const raw of parsed.templates) {
        if (!raw || typeof raw !== 'object') continue;
        const t = raw as Partial<EmailTemplate>;
        if (typeof t.name !== 'string' || typeof t.body !== 'string') continue;
        const now = new Date().toISOString();
        incoming.push({
          id: typeof t.id === 'string' ? t.id : genId(),
          name: t.name,
          subject: typeof t.subject === 'string' ? t.subject : '',
          body: t.body,
          category: typeof t.category === 'string' ? t.category : '',
          isFavorite: !!t.isFavorite,
          createdAt: typeof t.createdAt === 'string' ? t.createdAt : now,
          updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : now,
        });
      }
      const existing = get().templates;
      const existingIds = new Set(existing.map((t) => t.id));
      const merged = [
        ...existing,
        ...incoming.map((t) => (existingIds.has(t.id) ? { ...t, id: genId() } : t)),
      ];
      set({ templates: merged });
      persist(merged);
      return { count: incoming.length };
    } catch (err) {
      return { count: 0, error: err instanceof Error ? err.message : 'Parse failed' };
    }
  },
}));
