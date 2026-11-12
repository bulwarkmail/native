import { beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

// The delivery method buttons of the notification settings, run through the
// hook renderer of the card tests (no React Native renderer in the test env):
// the screen's own elements are searched for the button and pressed. The
// push setup itself is stubbed; the stored transport and the direct
// connection's service are the real ones, on the mocked storage and native
// module.

const native = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  setAccounts: vi.fn(async () => undefined),
}));

vi.mock('react-native', () => {
  const host = (name: string) => name;
  return {
    Platform: { OS: 'android', Version: 33, select: <T,>(s: { default?: T; android?: T }) => s.android ?? s.default },
    NativeModules: { BulwarkFcm: { getToken: async () => 'token', deleteToken: async () => undefined }, BulwarkDirectPush: native },
    NativeEventEmitter: class { addListener() { return { remove: () => undefined }; } },
    PermissionsAndroid: { RESULTS: { GRANTED: 'granted' }, request: async () => 'granted' },
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    Linking: { openURL: async () => undefined, sendIntent: async () => undefined },
    StyleSheet: { create: (s: unknown) => s },
    ActivityIndicator: host('ActivityIndicator'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
  };
});
vi.mock('../../icons', () => ({ CheckCircle2: 'Icon', RefreshCw: 'Icon', XCircle: 'Icon' }));
vi.mock('../../Button', () => ({ default: 'Button' }));
vi.mock('../../Dialog', () => ({ default: 'Dialog' }));
vi.mock('../settings-section', () => ({ SettingsSection: 'SettingsSection', SettingItem: 'SettingItem', ToggleSwitch: 'ToggleSwitch' }));
vi.mock('../../../theme/colors', () => ({ useColors: () => ({}) }));
vi.mock('../../../theme/tokens', () => ({ radius: {}, spacing: {}, typography: {} }));
vi.mock('../../../stores/locale-store', () => {
  const t = (_key: string, fallback: string) => fallback;
  return { t, useLocaleStore: (select: (s: { t: typeof t }) => unknown) => select({ t }) };
});
vi.mock('../../../stores/auth-store', () => {
  const state = { username: 'u', activeAccountId: 'u@mail.example', client: {} };
  return { useAuthStore: (select: (s: typeof state) => unknown) => select(state) };
});
const settings = vi.hoisted(() => {
  const state: Record<string, unknown> = { hydrated: true, hydrate: () => undefined, notificationMutes: {}, emailNotificationsEnabled: true };
  // Persisted as the store persists it: the push code reads the stored settings.
  state.updateSetting = (key: string, value: unknown) => {
    state[key] = value;
    void AsyncStorage.setItem('webmail:settings:v1', JSON.stringify({ emailNotificationsEnabled: state.emailNotificationsEnabled }));
  };
  return state;
});
vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: Object.assign((select: (s: typeof settings) => unknown) => select(settings), { getState: () => settings }),
}));
vi.mock('../../../stores/email-store', () => {
  const state = { mailboxes: [] };
  return { useEmailStore: (select: (s: typeof state) => unknown) => select(state) };
});
vi.mock('../../../stores/account-store', () => {
  const state = { accounts: [] };
  return { useAccountStore: (select: (s: typeof state) => unknown) => select(state) };
});
vi.mock('../../../stores/policy-store', () => ({ useSettingHidden: () => false, useSettingLocked: () => false }));
vi.mock('../../../lib/unified-push', () => ({
  getSavedUnifiedPushDistributor: async () => null,
  getUnifiedPushDistributors: async () => [],
  isUnifiedPushSupported: () => false,
  saveUnifiedPushDistributor: async () => undefined,
}));
vi.mock('../../../lib/app-badge', () => ({ canBadgeAppIcon: () => false }));
vi.mock('../../../lib/notification-mutes', () => ({ isAccountMuted: () => false, setAccountMuted: () => undefined }));
vi.mock('../../../api/jmap-client', () => ({
  jmapClient: { accountId: 'A1' },
  JMAPClient: class {},
  credentialsKey: () => 'creds',
  primaryJmapAccountId: () => 'A1',
}));
vi.mock('../../../lib/push-notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/push-notifications')>()),
  isPushActiveForAccount: vi.fn(async () => true),
  serverSupportsEmailPush: vi.fn(() => false),
  listPushDevices: async () => [],
  mailAccountsWithoutPush: async () => [],
  enablePushFromSettings: vi.fn(),
  setUpOtherPushAccounts: vi.fn(async () => undefined),
  setupDirectPushForOtherAccounts: vi.fn(async () => undefined),
}));

import {
  enablePushFromSettings,
  getStoredPushTransport,
  isPushActiveForAccount,
  serverSupportsEmailPush,
  setUpOtherPushAccounts,
  setupDirectPushForOtherAccounts,
  PushSetupError,
  setStoredPushTransport,
  type PushTransport,
} from '../../../lib/push-notifications';
import { directPushCredentialsTask } from '../../../lib/direct-push-task';
import { NotificationSettings } from '../NotificationSettings';
import { renderHook, waitFor } from '../../email/structured-mail/__tests__/render-native';

const enable = vi.mocked(enablePushFromSettings);
const setUpOthers = vi.mocked(setUpOtherPushAccounts);

type Element = { type: unknown; props: Record<string, unknown> };

function find(node: unknown, match: (element: Element) => boolean): Element | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return null;
  }
  const element = node as Element;
  if (match(element)) return element;
  return find(element.props?.children, match);
}

const findButton = (node: unknown, label: string) =>
  find(node, (e) => e.type === 'Button' && e.props.children === label);
const findText = (node: unknown, text: string) =>
  find(node, (e) => e.type === 'Text' && e.props.children === text);

// The screen for the open account, which is the one push account.
async function openScreen(transport: PushTransport, relay = 'https://relay.example', pushOn = true) {
  vi.mocked(isPushActiveForAccount).mockResolvedValue(pushOn);
  settings.emailNotificationsEnabled = true;
  await AsyncStorage.clear();
  await setStoredPushTransport(transport);
  await AsyncStorage.setItem('push:relayBaseUrl:v1', relay);
  await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify(['u@mail.example']));
  const screen = renderHook(() => NotificationSettings() as unknown);
  await waitFor(() => expect(findButton(screen.current, 'Direct')?.props.variant).toBe(transport === 'direct' ? 'default' : 'outline'));
  if (pushOn) await waitFor(() => expect(findButton(screen.current, 'Re-register')).not.toBeNull());
  native.start.mockClear();
  native.stop.mockClear();
  return screen;
}

async function press(screen: { current: unknown }, label: string): Promise<void> {
  await (findButton(screen.current, label)!.props.onPress as () => Promise<void> | void)();
  // The screen drops the switch's promise: wait until it is no longer busy,
  // then let a rollback's storage writes run (the mocked storage answers at once).
  await waitFor(() => expect(findButton(screen.current, 'Direct')?.props.disabled).toBe(false));
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const failed = (phase: 'platform' | 'relay') => ({
  error: new PushSetupError(phase, 'refused'),
  relayBaseUrl: 'https://relay.example',
  enabled: phase === 'relay',
});

beforeEach(() => {
  enable.mockReset();
  setUpOthers.mockClear();
});

describe('switching the delivery method with push on', () => {
  it('goes back to the relay, without ever starting the direct service, when the switch to Direct fails', async () => {
    const screen = await openScreen('fcm');
    enable.mockResolvedValue(failed('platform'));
    await press(screen, 'Direct');
    expect(enable).toHaveBeenCalledTimes(1);
    expect(await getStoredPushTransport()).toBe('fcm');
    expect(native.start).not.toHaveBeenCalled();
    expect(native.stop).not.toHaveBeenCalled();
  });

  it('stays on Direct, with its service running again, when the switch away from it fails', async () => {
    const screen = await openScreen('direct');
    // The service asks for the accounts while the relay's setup runs, and
    // stops: the other transport is stored meanwhile.
    enable.mockImplementation(async () => {
      await directPushCredentialsTask({ request: 1 });
      return failed('relay');
    });
    await press(screen, 'Google (FCM)');
    expect(enable).toHaveBeenCalledTimes(1);
    expect(await getStoredPushTransport()).toBe('direct');
    expect(native.stop).toHaveBeenCalledTimes(1);
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.stop.mock.invocationCallOrder[0]).toBeLessThan(native.start.mock.invocationCallOrder[0]);
    expect(setUpOthers).not.toHaveBeenCalled();
  });

  it('moves to Direct although the relay field holds no valid address', async () => {
    const screen = await openScreen('fcm', 'http://not-https.example');
    enable.mockResolvedValue({ error: null, relayBaseUrl: 'http://not-https.example', enabled: true });
    await press(screen, 'Direct');
    expect(enable).toHaveBeenCalledTimes(1);
    expect(await getStoredPushTransport()).toBe('direct');
  });

  it('refuses to leave Direct for a relay whose address is not valid, and stays on Direct', async () => {
    const screen = await openScreen('direct', 'http://not-https.example');
    await press(screen, 'Google (FCM)');
    expect(enable).not.toHaveBeenCalled();
    expect(findText(screen.current, 'Enter a valid https:// URL')).not.toBeNull();
    expect(await getStoredPushTransport()).toBe('direct');
    expect(native.stop).not.toHaveBeenCalled();
  });
});

describe('turning push on', () => {
  it('goes through the settings enable path, which records the Inbox mail already there, on Direct', async () => {
    const screen = await openScreen('direct', 'https://relay.example', false);
    enable.mockResolvedValue({ error: null, relayBaseUrl: 'https://relay.example', enabled: true });
    const enableSwitch = find(
      find(screen.current, (e) => e.type === 'SettingItem' && e.props.label === 'Enable'),
      (e) => e.type === 'ToggleSwitch',
    )!;
    (enableSwitch.props.onChange as (v: boolean) => void)(true);
    await waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
  });
});

describe('leaving Direct', () => {
  it('brings the other accounts back on the chosen transport once the switch has succeeded', async () => {
    const screen = await openScreen('direct');
    enable.mockResolvedValue({ error: null, relayBaseUrl: 'https://relay.example', enabled: true });
    await press(screen, 'Google (FCM)');
    expect(await getStoredPushTransport()).toBe('fcm');
    expect(setUpOthers).toHaveBeenCalledTimes(1);
    expect(setUpOthers).toHaveBeenCalledWith('https://relay.example');
    expect(enable.mock.invocationCallOrder[0]).toBeLessThan(setUpOthers.mock.invocationCallOrder[0]);
  });

  it('brings them back also while push is off for the account on screen', async () => {
    const screen = await openScreen('direct', 'https://relay.example', false);
    await press(screen, 'Google (FCM)');
    expect(enable).not.toHaveBeenCalled();
    expect(await getStoredPushTransport()).toBe('fcm');
    expect(setUpOthers).toHaveBeenCalledWith('https://relay.example');
  });

  it('moves the other accounts to Direct while push is off for the account on screen', async () => {
    const screen = await openScreen('fcm', 'https://relay.example', false);
    await press(screen, 'Direct');
    expect(enable).not.toHaveBeenCalled();
    expect(setupDirectPushForOtherAccounts).toHaveBeenCalledTimes(1);
    expect(await getStoredPushTransport()).toBe('direct');
  });

  it('stays on the relay, saying why, when moving the other accounts to Direct is refused', async () => {
    const screen = await openScreen('fcm', 'https://relay.example', false);
    vi.mocked(setupDirectPushForOtherAccounts).mockRejectedValueOnce(new PushSetupError('jmap', 'The mail server of bob offers no event stream'));
    await press(screen, 'Direct');
    expect(await getStoredPushTransport()).toBe('fcm');
    const said = find(screen.current, (e) => e.type === 'Text' && String(e.props.children).includes('The mail server of bob'));
    expect(said).not.toBeNull();
  });

  it('leaves them to the direct setup on a move back to Direct', async () => {
    const screen = await openScreen('direct');
    enable.mockResolvedValue({ error: null, relayBaseUrl: 'https://relay.example', enabled: true });
    await press(screen, 'Google (FCM)');
    setUpOthers.mockClear();
    enable.mockResolvedValue({ error: null, relayBaseUrl: 'https://relay.example', enabled: true });
    await press(screen, 'Direct');
    expect(setUpOthers).not.toHaveBeenCalled();
  });
});

describe('the email notifications switch', () => {
  const emailSwitch = (node: unknown) => find(
    find(node, (e) => e.type === 'SettingItem' && e.props.label === 'Email notifications'),
    (e) => e.type === 'ToggleSwitch',
  )!;

  it('stops the direct service when turned off, and starts it when turned on again', async () => {
    const screen = await openScreen('direct');
    // The service runs.
    await AsyncStorage.setItem('push:directWanted:v1', '1');
    (emailSwitch(screen.current).props.onChange as (v: boolean) => void)(false);
    await waitFor(() => expect(native.stop).toHaveBeenCalledTimes(1));
    expect(native.start).not.toHaveBeenCalled();

    (emailSwitch(screen.current).props.onChange as (v: boolean) => void)(true);
    await waitFor(() => expect(native.start).toHaveBeenCalledTimes(1));
    expect(native.stop).toHaveBeenCalledTimes(1);
  });
});

describe('the email settings over the direct connection', () => {
  const inboxOnly = (node: unknown) => find(node, (e) => e.type === 'SettingItem' && e.props.label === 'Inbox only');
  const inboxLine = 'Over the direct connection, only new mail in the Inbox is notified.';

  it('offers no Inbox-only switch, which it cannot honour, and says it notifies the Inbox only', async () => {
    vi.mocked(serverSupportsEmailPush).mockReturnValue(true);
    try {
      const direct = await openScreen('direct');
      expect(inboxOnly(direct.current)).toBeNull();
      expect(findText(direct.current, inboxLine)).not.toBeNull();

      const relay = await openScreen('fcm');
      expect(inboxOnly(relay.current)).not.toBeNull();
      expect(findText(relay.current, inboxLine)).toBeNull();
    } finally {
      vi.mocked(serverSupportsEmailPush).mockReturnValue(false);
    }
  });
});
