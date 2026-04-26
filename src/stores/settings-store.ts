import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Identity } from '../api/types';
import { getIdentities as fetchIdentities } from '../api/identity';

export type ExternalContentPolicy = 'allow' | 'block' | 'ask';
export type ThemeMode = 'light' | 'dark' | 'system';
export type FontSize = 'small' | 'medium' | 'large';
export type Density = 'extra-compact' | 'compact' | 'regular' | 'comfortable';

const STORAGE_KEY = 'webmail:settings:v1';

export type SwipeAction = 'none' | 'archive' | 'delete' | 'spam' | 'read' | 'star';

interface PersistedSettings {
  externalContentPolicy: ExternalContentPolicy;
  trustedSenders: string[];
  senderFavicons: boolean;
  groupContactsByLetter: boolean;
  // Appearance
  theme: ThemeMode;
  fontSize: FontSize;
  density: Density;
  showToolbarLabels: boolean;
  animationsEnabled: boolean;
  emailAlwaysLightMode: boolean;
  // Composing
  autoSelectReplyIdentity: boolean;
  attachmentReminderEnabled: boolean;
  attachmentReminderKeywords: string[];
  // Layout / list interactions
  swipeLeftAction: SwipeAction;
  swipeRightAction: SwipeAction;
}

const DEFAULT_PERSISTED: PersistedSettings = {
  externalContentPolicy: 'ask',
  trustedSenders: [],
  senderFavicons: true,
  groupContactsByLetter: true,
  theme: 'system',
  fontSize: 'medium',
  density: 'regular',
  showToolbarLabels: true,
  animationsEnabled: true,
  emailAlwaysLightMode: false,
  autoSelectReplyIdentity: true,
  attachmentReminderEnabled: true,
  attachmentReminderKeywords: ['attached', 'attachment', 'attaching', 'enclosed'],
  swipeLeftAction: 'archive',
  swipeRightAction: 'read',
};

export interface SettingsState extends PersistedSettings {
  identities: Identity[];
  loading: boolean;
  error: string | null;
  hydrated: boolean;

  fetchIdentities: () => Promise<void>;
  hydrate: () => Promise<void>;
  setExternalContentPolicy: (policy: ExternalContentPolicy) => void;
  setSenderFavicons: (enabled: boolean) => void;
  setGroupContactsByLetter: (enabled: boolean) => void;
  setTheme: (theme: ThemeMode) => void;
  setFontSize: (size: FontSize) => void;
  setDensity: (density: Density) => void;
  setShowToolbarLabels: (enabled: boolean) => void;
  setAnimationsEnabled: (enabled: boolean) => void;
  setEmailAlwaysLightMode: (enabled: boolean) => void;
  setAutoSelectReplyIdentity: (enabled: boolean) => void;
  setAttachmentReminderEnabled: (enabled: boolean) => void;
  setAttachmentReminderKeywords: (keywords: string[]) => void;
  setSwipeLeftAction: (action: SwipeAction) => void;
  setSwipeRightAction: (action: SwipeAction) => void;
  addTrustedSender: (email: string) => void;
  removeTrustedSender: (email: string) => void;
  isSenderTrusted: (email: string) => boolean;
  reset: () => void;
}

function snapshot(state: SettingsState): PersistedSettings {
  return {
    externalContentPolicy: state.externalContentPolicy,
    trustedSenders: state.trustedSenders,
    senderFavicons: state.senderFavicons,
    groupContactsByLetter: state.groupContactsByLetter,
    theme: state.theme,
    fontSize: state.fontSize,
    density: state.density,
    showToolbarLabels: state.showToolbarLabels,
    animationsEnabled: state.animationsEnabled,
    emailAlwaysLightMode: state.emailAlwaysLightMode,
    autoSelectReplyIdentity: state.autoSelectReplyIdentity,
    attachmentReminderEnabled: state.attachmentReminderEnabled,
    attachmentReminderKeywords: state.attachmentReminderKeywords,
    swipeLeftAction: state.swipeLeftAction,
    swipeRightAction: state.swipeRightAction,
  };
}

function persist(state: PersistedSettings): void {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch((err) => {
    console.warn('[settings-store] persist failed', err);
  });
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_PERSISTED,
  identities: [],
  loading: false,
  error: null,
  hydrated: false,

  fetchIdentities: async () => {
    set({ loading: true, error: null });
    try {
      const identities = await fetchIdentities();
      set({ identities, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load identities' });
    }
  },

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
        set({
          externalContentPolicy: parsed.externalContentPolicy ?? DEFAULT_PERSISTED.externalContentPolicy,
          trustedSenders: Array.isArray(parsed.trustedSenders) ? parsed.trustedSenders : [],
          senderFavicons: typeof parsed.senderFavicons === 'boolean' ? parsed.senderFavicons : DEFAULT_PERSISTED.senderFavicons,
          groupContactsByLetter: typeof parsed.groupContactsByLetter === 'boolean' ? parsed.groupContactsByLetter : DEFAULT_PERSISTED.groupContactsByLetter,
          theme: parsed.theme ?? DEFAULT_PERSISTED.theme,
          fontSize: parsed.fontSize ?? DEFAULT_PERSISTED.fontSize,
          density: parsed.density ?? DEFAULT_PERSISTED.density,
          showToolbarLabels: typeof parsed.showToolbarLabels === 'boolean' ? parsed.showToolbarLabels : DEFAULT_PERSISTED.showToolbarLabels,
          animationsEnabled: typeof parsed.animationsEnabled === 'boolean' ? parsed.animationsEnabled : DEFAULT_PERSISTED.animationsEnabled,
          emailAlwaysLightMode: typeof parsed.emailAlwaysLightMode === 'boolean' ? parsed.emailAlwaysLightMode : DEFAULT_PERSISTED.emailAlwaysLightMode,
          autoSelectReplyIdentity: typeof parsed.autoSelectReplyIdentity === 'boolean' ? parsed.autoSelectReplyIdentity : DEFAULT_PERSISTED.autoSelectReplyIdentity,
          attachmentReminderEnabled: typeof parsed.attachmentReminderEnabled === 'boolean' ? parsed.attachmentReminderEnabled : DEFAULT_PERSISTED.attachmentReminderEnabled,
          attachmentReminderKeywords: Array.isArray(parsed.attachmentReminderKeywords) ? parsed.attachmentReminderKeywords : DEFAULT_PERSISTED.attachmentReminderKeywords,
          swipeLeftAction: parsed.swipeLeftAction ?? DEFAULT_PERSISTED.swipeLeftAction,
          swipeRightAction: parsed.swipeRightAction ?? DEFAULT_PERSISTED.swipeRightAction,
          hydrated: true,
        });
        return;
      }
    } catch (err) {
      console.warn('[settings-store] hydrate failed', err);
    }
    set({ hydrated: true });
  },

  setExternalContentPolicy: (policy) => { set({ externalContentPolicy: policy }); persist(snapshot(get())); },
  setSenderFavicons: (enabled) => { set({ senderFavicons: enabled }); persist(snapshot(get())); },
  setGroupContactsByLetter: (enabled) => { set({ groupContactsByLetter: enabled }); persist(snapshot(get())); },
  setTheme: (theme) => { set({ theme }); persist(snapshot(get())); },
  setFontSize: (fontSize) => { set({ fontSize }); persist(snapshot(get())); },
  setDensity: (density) => { set({ density }); persist(snapshot(get())); },
  setShowToolbarLabels: (enabled) => { set({ showToolbarLabels: enabled }); persist(snapshot(get())); },
  setAnimationsEnabled: (enabled) => { set({ animationsEnabled: enabled }); persist(snapshot(get())); },
  setEmailAlwaysLightMode: (enabled) => { set({ emailAlwaysLightMode: enabled }); persist(snapshot(get())); },
  setAutoSelectReplyIdentity: (enabled) => { set({ autoSelectReplyIdentity: enabled }); persist(snapshot(get())); },
  setAttachmentReminderEnabled: (enabled) => { set({ attachmentReminderEnabled: enabled }); persist(snapshot(get())); },
  setAttachmentReminderKeywords: (keywords) => { set({ attachmentReminderKeywords: keywords }); persist(snapshot(get())); },
  setSwipeLeftAction: (action) => { set({ swipeLeftAction: action }); persist(snapshot(get())); },
  setSwipeRightAction: (action) => { set({ swipeRightAction: action }); persist(snapshot(get())); },

  addTrustedSender: (email) => {
    const normalized = email.toLowerCase().trim();
    if (!normalized) return;
    const current = get().trustedSenders;
    if (current.includes(normalized)) return;
    set({ trustedSenders: [...current, normalized] });
    persist(snapshot(get()));
  },

  removeTrustedSender: (email) => {
    const normalized = email.toLowerCase().trim();
    set({ trustedSenders: get().trustedSenders.filter((e) => e !== normalized) });
    persist(snapshot(get()));
  },

  isSenderTrusted: (email) => {
    const normalized = email.toLowerCase().trim();
    return get().trustedSenders.includes(normalized);
  },

  reset: () => set({
    identities: [],
    loading: false,
    error: null,
  }),
}));
