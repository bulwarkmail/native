// Mobile-side templates store. Mirrors the webmail's `template-store` but
// keeps the surface minimal — categories, defaults, placeholders, and the
// favourite/recent tracking are not yet exposed in the mobile UI. We persist
// the same shape so an export from one platform imports cleanly into the
// other.
//
// Where the templates live (webmail lib/templates/personal-templates.ts):
// on a server that keeps JMAP Metadata (Stalwart 1.0.0 and later) in the
// login's own Inbox metadata, shared with the webmail and every other
// device, one list per login; elsewhere (Stalwart 0.16) on this device, as
// before. The device list goes into the first login whose server keeps them,
// and only that one, so one person's templates don't turn up in every
// account signed in here. Team templates, kept in a group account's Inbox,
// are read for the picker; they are changed in the webmail. The webmail's
// organisation library and its locks need the organisation policy, which
// the app can't read, so they are not here.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { exportTemplates, importTemplates as parseTemplateImport } from '../lib/template-utils';
import {
  getBulwarkMetadata, groupAccounts, MetadataTooLargeError, setBulwarkMetadata, supportsBulwarkMetadata,
} from '../api/bulwark-metadata';
import { jmapClient } from '../api/jmap-client';
import {
  isTooLargeForMetadata, MARKER_KEY, MARKER_VERSION, markerFromMetadata, mergeTemplateLists, planPersonalSync,
  sameTombstones, templateKey, templatesFromMetadata, withStorableId, type TemplateList,
} from '../lib/compose-templates';
import { composerLoginMoved, servedLoginOf } from '../lib/draft-login';
import { useAccountStore } from './account-store';

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  /** Body is HTML (inserted verbatim) rather than plain text. */
  isHTML?: boolean;
  category: string;
  defaultRecipients?: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
  };
  identityId?: string;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The templates of a group mailbox the user is a member of. */
export interface TeamTemplates {
  accountId: string;
  name: string;
  templates: EmailTemplate[];
}

const STORAGE_KEY = 'webmail:templates:v1';

interface TemplatesState {
  /** The templates of the active login: its account's, or this device's. */
  templates: EmailTemplate[];
  /** Whether `templates` live in the account (Metadata) rather than on this device. */
  storedInAccount: boolean;
  /** Team templates of the active login's group accounts, read-only here. */
  teams: TeamTemplates[];
  hydrated: boolean;
  /** This device's list: every login on a server without Metadata uses it. */
  device: EmailTemplate[];
  /** Per login (registry id): its account's templates and tombstones, as last synced. */
  accounts: Record<string, TemplateList>;
  /** The login the device list went into; null while none took it. */
  deviceListOwner: string | null;

  hydrate: () => Promise<void>;
  addTemplate: (
    data: Pick<EmailTemplate, 'name' | 'subject' | 'body'>
      & Partial<Pick<EmailTemplate, 'category' | 'isFavorite' | 'isHTML' | 'defaultRecipients' | 'identityId'>>,
  ) => EmailTemplate;
  updateTemplate: (id: string, updates: Partial<Omit<EmailTemplate, 'id' | 'createdAt'>>) => void;
  deleteTemplate: (id: string) => void;
  exportAll: () => string;
  importTemplates: (json: string) => { count: number; error?: string };
  /** Sync the active login's templates with its account and read its team templates. */
  refresh: (options?: { force?: boolean }) => Promise<void>;
}

/** Whether the client serves another login than `login` now (lib/draft-login). */
function loginMovedFrom(login: string): boolean {
  return composerLoginMoved(login, {
    activeAccountId: useAccountStore.getState().activeAccountId,
    servedLogin: servedLoginOf(jmapClient),
  });
}

/** The login the JMAP client serves, or the registry's active one while it connects. */
function activeLogin(): string | null {
  return servedLoginOf(jmapClient) ?? useAccountStore.getState().activeAccountId;
}

function persist(state: Pick<TemplatesState, 'device' | 'accounts' | 'deviceListOwner'>): void {
  const value = { templates: state.device, accounts: state.accounts, deviceListOwner: state.deviceListOwner };
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(value)).catch((err) => {
    console.warn('[templates-store] persist failed', err);
  });
}

function genId(): string {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** What the UI shows for the active login. */
function visibleFor(state: Pick<TemplatesState, 'device' | 'accounts'>, login: string | null): Pick<TemplatesState, 'templates' | 'storedInAccount'> {
  const account = login ? state.accounts[login] : undefined;
  return account ? { templates: account.templates, storedInAccount: true } : { templates: state.device, storedInAccount: false };
}

// Bumped by every local change of an account's list, so a sync round that
// ran meanwhile plans once more instead of overwriting it.
const editVersions = new Map<string, number>();
const bump = (login: string) => editVersions.set(login, (editVersions.get(login) ?? 0) + 1);

export const useTemplatesStore = create<TemplatesState>((set, get) => {
  /** Change the active login's list, wherever it lives. */
  const change = (fn: (list: TemplateList) => TemplateList) => {
    const login = activeLogin();
    const state = get();
    if (login && state.accounts[login]) {
      const accounts = { ...state.accounts, [login]: fn(state.accounts[login]) };
      bump(login);
      set({ accounts, ...visibleFor({ device: state.device, accounts }, login) });
      persist(get());
      scheduleSync();
      return;
    }
    const device = fn({ templates: state.device, deletedTemplateIds: {} }).templates;
    set({ device, ...visibleFor({ device, accounts: state.accounts }, login) });
    persist(get());
    // The first save may be what makes a Metadata server take the list.
    scheduleSync();
  };

  return {
    templates: [],
    storedInAccount: false,
    teams: [],
    hydrated: false,
    device: [],
    accounts: {},
    deviceListOwner: null,

    hydrate: async () => {
      if (get().hydrated) return;
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            templates?: EmailTemplate[];
            accounts?: Record<string, TemplateList>;
            deviceListOwner?: string | null;
          };
          const device = Array.isArray(parsed.templates) ? parsed.templates : [];
          const accounts = parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {};
          set({
            device,
            accounts,
            deviceListOwner: typeof parsed.deviceListOwner === 'string' ? parsed.deviceListOwner : null,
            ...visibleFor({ device, accounts }, activeLogin()),
            hydrated: true,
          });
          return;
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
        isHTML: data.isHTML,
        defaultRecipients: data.defaultRecipients,
        identityId: data.identityId,
        isFavorite: data.isFavorite ?? false,
        createdAt: now,
        updatedAt: now,
      };
      change((list) => ({ ...list, templates: [...list.templates, template] }));
      return template;
    },

    updateTemplate: (id, updates) => {
      change((list) => ({
        ...list,
        templates: list.templates.map((t) =>
          t.id === id ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t,
        ),
      }));
    },

    deleteTemplate: (id) => {
      // In the account a tombstone deletes it everywhere; only tombstones
      // delete (lib/compose-templates).
      change((list) => ({
        templates: list.templates.filter((t) => t.id !== id),
        deletedTemplateIds: { ...list.deletedTemplateIds, [id]: new Date().toISOString() },
      }));
    },

    // Webmail export envelope (type: 'webmail-templates', exportedAt) so a
    // file exported here imports on the web and vice versa.
    exportAll: () => exportTemplates(get().templates),

    importTemplates: (json) => {
      const result = parseTemplateImport(json);
      if (result.errors.length && result.templates.length === 0) {
        return { count: 0, error: result.errors[0] };
      }
      if (result.templates.length === 0) return { count: 0 };
      change((list) => ({ ...list, templates: [...list.templates, ...result.templates] }));
      return { count: result.templates.length };
    },

    refresh: async (options) => {
      if (!get().hydrated) await get().hydrate();
      const login = activeLogin();
      if (!login) return;
      const last = lastRefresh.get(login) ?? 0;
      if (!options?.force && Date.now() - last < 15_000) return;
      lastRefresh.set(login, Date.now());
      await Promise.all([syncPersonal(login), loadTeams(login)]);
    },
  };
});

const lastRefresh = new Map<string, number>();
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** Sync shortly after a change, once for a burst of changes. */
function scheduleSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    const login = activeLogin();
    if (login) void syncPersonal(login);
  }, 800);
}

const running = new Map<string, Promise<void>>();

/** One sync round for `login` at a time; one asked for meanwhile runs after it. */
export function syncPersonal(login: string): Promise<void> {
  const current = running.get(login);
  if (current) return current.then(() => syncPersonal(login));
  const round = syncRound(login).catch((err) => {
    console.warn('[templates-store] sync failed', err);
  }).finally(() => running.delete(login));
  running.set(login, round);
  return round;
}

/**
 * One round for the login the client serves: read the account's templates
 * and tombstones, merge them with this device's copy, upload what the server
 * lacks, write the tombstones, then remove what they cover (webmail
 * account-template-sync). A login whose server keeps no metadata keeps the
 * device list. A switch of logins ends the round without writing more.
 */
async function syncRound(login: string): Promise<void> {
  if (loginMovedFrom(login) || !jmapClient.isConnected) return;
  const accountId = jmapClient.accountId;
  if (!supportsBulwarkMetadata(accountId)) return;
  const entries = await getBulwarkMetadata(accountId);
  if (!entries || loginMovedFrom(login)) return;

  const server = templatesFromMetadata(entries);
  const marker = markerFromMetadata(entries);
  const serverTombstones = marker ?? {};
  const store = useTemplatesStore.getState();
  const version = editVersions.get(login) ?? 0;

  let start: TemplateList = store.accounts[login] ?? { templates: [], deletedTemplateIds: {} };
  let claimed = false;
  // The device list goes into the first login that keeps templates, once.
  if (!store.accounts[login] && store.deviceListOwner === null && store.device.length > 0) {
    start = mergeTemplateLists(start, { templates: store.device.map(withStorableId), deletedTemplateIds: {} });
    claimed = true;
  }
  start = { ...start, templates: start.templates.map(withStorableId) };

  const plan = planPersonalSync(start, server, serverTombstones);
  const serverAfter: Record<string, EmailTemplate> = { ...server };
  let reachable = true;
  for (const template of plan.uploads) {
    // Too large for one entry: it stays on this device only.
    if (isTooLargeForMetadata(template) || !reachable) continue;
    if (loginMovedFrom(login)) return;
    try {
      await setBulwarkMetadata(accountId, templateKey(template.id), template);
      serverAfter[template.id] = template;
    } catch (err) {
      if (!(err instanceof MetadataTooLargeError)) {
        console.warn('[templates-store] could not save a template in the account', err);
        reachable = false;
      }
    }
  }
  // The tombstones go up before the entries they delete come off.
  let serverDeleted = serverTombstones;
  if (reachable && (marker === null || !sameTombstones(marker, plan.deletedTemplateIds))) {
    if (loginMovedFrom(login)) return;
    try {
      await setBulwarkMetadata(accountId, MARKER_KEY, { version: MARKER_VERSION, deleted: plan.deletedTemplateIds });
      serverDeleted = plan.deletedTemplateIds;
    } catch (err) {
      console.warn('[templates-store] could not save the deleted templates in the account', err);
      reachable = false;
    }
  }
  for (const id of plan.deletes) {
    if (!reachable || serverDeleted[id] === undefined) continue;
    if (loginMovedFrom(login)) return;
    try {
      await setBulwarkMetadata(accountId, templateKey(id), null);
      delete serverAfter[id];
    } catch (err) {
      console.warn('[templates-store] could not remove a template from the account', err);
      reachable = false;
    }
  }

  // Changes made here while the round ran come after it: plan them again
  // against the server as it is now, and go round once more for them.
  const latestState = useTemplatesStore.getState();
  const edited = (editVersions.get(login) ?? 0) !== version;
  const latest = edited ? (latestState.accounts[login] ?? start) : start;
  const final = planPersonalSync(latest, serverAfter, serverDeleted);
  const accounts = { ...latestState.accounts, [login]: { templates: final.templates, deletedTemplateIds: final.deletedTemplateIds } };
  const deviceListOwner = claimed ? login : latestState.deviceListOwner;
  useTemplatesStore.setState({
    accounts,
    deviceListOwner,
    ...(activeLogin() === login ? visibleFor({ device: latestState.device, accounts }, login) : {}),
  });
  persist({ device: latestState.device, accounts, deviceListOwner });
  if (edited) scheduleSync();
}

/** Read the team templates of the login's group accounts. */
async function loadTeams(login: string): Promise<void> {
  if (loginMovedFrom(login) || !jmapClient.isConnected) return;
  const teams: TeamTemplates[] = [];
  for (const group of await groupAccounts()) {
    if (!supportsBulwarkMetadata(group.id)) continue;
    const entries = await getBulwarkMetadata(group.id);
    if (!entries) continue;
    const templates = Object.values(templatesFromMetadata(entries));
    if (templates.length > 0) teams.push({ accountId: group.id, name: group.name, templates });
  }
  if (!loginMovedFrom(login)) useTemplatesStore.setState({ teams });
}

// Another login shows its own list; its teams are read again.
useAccountStore.subscribe((state, prev) => {
  if (state.activeAccountId === prev.activeAccountId) return;
  const store = useTemplatesStore.getState();
  useTemplatesStore.setState({ teams: [], ...visibleFor(store, state.activeAccountId) });
});
