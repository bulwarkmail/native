import { signOutWithGuard } from './src/lib/sign-out-guard';
import React from 'react';
import { ActivityIndicator, AppState, Linking, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import {
  DarkTheme, DefaultTheme, NavigationContainer, createNavigationContainerRef, useIsFocused,
} from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { Mail, Calendar, BookUser, HardDrive, Settings } from 'lucide-react-native';

import { startLiveUpdates, type LiveUpdatesHandle } from './src/api/push-stream';
import { jmapClient } from './src/api/jmap-client';
import type { StateChange } from './src/api/types';
import { dispatchStateChange, onStateChangeType } from './src/lib/state-change-bus';
import { startCalendarEventNotificationToasts } from './src/lib/calendar-event-notification-presenter';
import { useCalendarEventNotificationStore } from './src/stores/calendar-event-notification-store';
import {
  startCalendarNotificationSync,
  startCalendarReminderTapHandling,
} from './src/lib/calendar-notifications';
import { startLivenessMonitor } from './src/lib/connection-liveness';
import { startDeviceSyncTriggers } from './src/device-sync/app/triggers';
import {
  setPendingCalendarOpen,
  type CalendarReminderTarget,
} from './src/navigation/pending-calendar-open';
import { sweepStaleExportFiles } from './src/lib/email-export';
import { useFilterStore } from './src/stores/filter-store';
import { useVacationStore } from './src/stores/vacation-store';
import {
  addMessageListener,
  addNotificationTapListener,
  addTokenRefreshListener,
  getInitialNotificationTap,
  getStoredRelayBaseUrl,
  notificationTapJmapAccountId,
  resyncPushNotifications,
  teardownPushNotificationsForAccount,
  type NotificationTapPayload,
} from './src/lib/push-notifications';
import { markPushRenewed, renewPushOnResume } from './src/lib/push-renewal';
import { watchInboxOnlyChange } from './src/lib/push-inbox-only';
import { addUnifiedPushEndpointListener } from './src/lib/unified-push';
import type { MainTabsParamList, RootStackParamList } from './src/navigation/types';
import ComposeScreen from './src/screens/ComposeScreen';
import EmailThreadScreen from './src/screens/EmailThreadScreen';
import EmailSourceScreen from './src/screens/EmailSourceScreen';
import LoginScreen from './src/screens/LoginScreen';
import EmailListScreen from './src/screens/EmailListScreen';
import FilesScreen from './src/screens/FilesScreen';
import CalendarScreen from './src/screens/CalendarScreen';
import ContactsScreen from './src/screens/ContactsScreen';
import ContactDetailScreen from './src/screens/ContactDetailScreen';
import ContactFormScreen from './src/screens/ContactFormScreen';
import GroupDetailScreen from './src/screens/GroupDetailScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ScheduledScreen from './src/screens/ScheduledScreen';
import OutboxScreen from './src/screens/OutboxScreen';
import UnifiedInboxScreen from './src/screens/UnifiedInboxScreen';
import { useAccountStore } from './src/stores/account-store';
import { useAuthStore } from './src/stores/auth-store';
import { useCalendarStore } from './src/stores/calendar-store';
import { useContactsStore } from './src/stores/contacts-store';
import { useEmailStore, viewerParamsForRow } from './src/stores/email-store';
import { mailboxAccountId } from './src/lib/mailbox-tree';
import { loadDetail, prefetchMessage } from './src/lib/email-detail-cache';
import { useHasCalendar, useHasContacts, useHasFiles } from './src/lib/capabilities';
import { useSettingsStore } from './src/stores/settings-store';
import { useLocaleStore } from './src/stores/locale-store';
import { toast } from './src/stores/toast-store';
import { useNetworkStore } from './src/stores/network-store';
import { shouldRetrySession, startSessionRetry } from './src/lib/session-retry';
import { useUpdatesStore } from './src/stores/updates-store';
import { UpdateBanner } from './src/components/UpdateBanner';
import { PushOnboardingPrompt } from './src/components/PushOnboardingPrompt';
import { ToastHost } from './src/components/ToastHost';
import { UndoSnackbar } from './src/components/UndoSnackbar';
import { AppIconBadge } from './src/components/AppIconBadge';
import { getEmails } from './src/api/email';
import { signOutWidgets, startWidgetSync } from './src/widgets/sync';
import { draftContextFromEmail } from './src/lib/draft-context';
import {
  acceptSignInLink,
  handleDeepLink,
  parseDeepLink,
  routeParkedSignInLink,
  shareToDeepLink,
  type DeepLink,
} from './src/navigation/linking';
import { usePendingSignInLinkStore } from './src/navigation/pending-sign-in-link';
import { MAX_ACCOUNTS } from './src/lib/account-utils';
import { addShareListener, getInitialShare, shareAttachments } from './src/lib/share-intent';
import { OfflineCacheBanner } from './src/components/OfflineCacheBanner';
import { useOfflineCacheStore } from './src/stores/offline-cache-store';
import { useOutboxStore } from './src/stores/outbox-store';
import { useSendQueueStore } from './src/stores/send-queue-store';
import { flushSendQueue, hasNewEntry } from './src/lib/send-queue-replay';
import { startOutboxToasts } from './src/lib/outbox-toasts';
import { runOfflineSync } from './src/lib/offline-sync';
import { spacing, typography, type ThemePalette } from './src/theme/tokens';
import { useColors } from './src/theme/colors';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabsParamList>();
const navigationRef = createNavigationContainerRef<RootStackParamList>();

// The launch URL is read once per process: Android hands the same intent back
// on every getInitialURL(), and a sign-in link must not run twice.
let initialSignInLinkRead = false;

async function navigateToNotificationTap(payload: NotificationTapPayload): Promise<void> {
  if (!navigationRef.isReady()) return;

  // The notification carries the account it was generated for. If the user
  // has since switched to a different account (or had a different one active
  // when the notification arrived), opening EmailThread under the active
  // account would fetch the email from the wrong server and fail.
  const auth = useAuthStore.getState();
  if (payload.accountId && payload.accountId !== auth.activeAccountId) {
    const account = useAccountStore.getState().getAccountById(payload.accountId);
    if (!account) return; // account was logged out — nothing safe to open.
    await auth.switchAccount(payload.accountId);
    if (useAuthStore.getState().activeAccountId !== payload.accountId) return;
  }

  if (!payload.emailId || !payload.threadId) {
    // A notification that names no message: show the account's mail.
    navigationRef.navigate('MainTabs', { screen: 'Mail' } as never);
    return;
  }

  prefetchMessage({ id: payload.emailId, threadId: payload.threadId });
  navigationRef.navigate('EmailThread', {
    emailId: payload.emailId,
    threadId: payload.threadId,
    subject: payload.subject,
    // A group mailbox's message lives under another JMAP account (#839).
    jmapAccountId: notificationTapJmapAccountId(payload),
  });
}

// A tapped calendar reminder opens its event (or task) in the Calendar tab,
// under the account it was scheduled for. The target is parked for
// CalendarScreen, which also picks it up when it mounts after a cold start.
async function openCalendarReminder(target: CalendarReminderTarget): Promise<void> {
  const auth = useAuthStore.getState();
  if (target.appAccountId && target.appAccountId !== auth.activeAccountId) {
    if (!useAccountStore.getState().getAccountById(target.appAccountId)) return;
    await auth.switchAccount(target.appAccountId);
    if (useAuthStore.getState().activeAccountId !== target.appAccountId) return;
  }
  setPendingCalendarOpen(target);
  // On a cold start the navigator mounts right after the auth gate flips.
  for (let attempt = 0; attempt < 50 && !navigationRef.isReady(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (navigationRef.isReady()) {
    navigationRef.navigate('MainTabs', { screen: 'Calendar' } as never);
  }
}

// Deep links (bulwarkmobile://, webmail https permalinks, mailto:) and
// Android share-sheet payloads all end up here once the navigator is ready.
async function openDeepLink(link: DeepLink): Promise<void> {
  const opened = await handleDeepLink(link, {
    navigation: navigationRef,
    resolveThreadId: async (emailId, jmapAccountId) => {
      try {
        const [email] = await getEmails([emailId], jmapAccountId);
        return email?.threadId ?? null;
      } catch {
        return null;
      }
    },
    openDraft: async (emailId, jmapAccountId) => {
      try {
        // Cache first, so a draft read before still opens offline.
        const draft = draftContextFromEmail(await loadDetail(emailId, jmapAccountId), jmapAccountId);
        if (!navigationRef.isReady()) return false;
        navigationRef.navigate('Compose', { draft });
        return true;
      } catch {
        return false;
      }
    },
    switchAccount: async (accountId) => {
      const auth = useAuthStore.getState();
      if (auth.activeAccountId === accountId) return true;
      if (!useAccountStore.getState().getAccountById(accountId)) return false;
      await auth.switchAccount(accountId);
      return useAuthStore.getState().activeAccountId === accountId;
    },
  });
  // A widget or a link elsewhere brought the app up for this; say it failed
  // rather than leave the user wondering why the app just opened.
  if (!opened) toast.error(useLocaleStore.getState().t('deep_link.open_failed', "Couldn't open this"));
}

// Toasts and the undo bar show on whichever stack screen is up, so a failure
// that lands after leaving the screen it came from (a viewer action finishing
// on the Unified Inbox or a contact) is still seen, and a reply held by the
// undo-send delay can be undone from the viewer it was sent from. Every
// screen carries the hosts, and only the focused one renders them, so
// neither ever shows twice (the screen below the top one is kept live).
// The composer gets no undo bar: its Undo would hand the open composer
// another draft. A held send's bar shows on the screen below once it closes.
function FocusedHosts({ undo }: { undo: boolean }) {
  if (!useIsFocused()) return null;
  return (
    <>
      {undo && <UndoSnackbar />}
      <ToastHost />
    </>
  );
}

function withHosts({ route, children }: { route: { name: string }; children: React.ReactElement }) {
  return (
    <>
      {children}
      <FocusedHosts undo={route.name !== 'Compose'} />
    </>
  );
}

function LoadingScreen({ message }: { message: string }) {
  const c = useColors();
  return (
    <View style={[styles.loadingContainer, { backgroundColor: c.background }]}>
      <ActivityIndicator color={c.primary} />
      <Text style={[styles.loadingText, { color: c.textSecondary }]}>{message}</Text>
    </View>
  );
}

function MainTabsNavigator({ navigation }: NativeStackScreenProps<RootStackParamList, 'MainTabs'>) {
  const c = useColors();
  // Select the count, not the list: every mailbox fetch sets a new array, and
  // re-rendering here re-renders the mail list with it.
  const inboxUnreadCount = useEmailStore(
    (state) => state.mailboxes.find((mailbox) => mailbox.role === 'inbox')?.unreadEmails ?? 0,
  );
  const hasCalendar = useHasCalendar();
  const hasContacts = useHasContacts();
  const hasFiles = useHasFiles();
  const disabledTabStyle = { opacity: 0.4 } as const;
  const t = useLocaleStore((state) => state.t);
  // The webmail's navigation names; a tab the server lacks says so.
  const tabLabels = {
    mail: t('sidebar.mail', 'Mail'),
    calendar: t('sidebar.calendar', 'Calendar'),
    contacts: t('sidebar.contacts', 'Contacts'),
    files: t('sidebar.files', 'Files'),
    settings: t('sidebar.settings', 'Settings'),
  };
  const unavailable = (name: string) => t('sidebar.tab_unavailable', '{name} (unavailable)', { name });

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <UpdateBanner />
      <OfflineCacheBanner />
      <PushOnboardingPrompt />
      <AppIconBadge />
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        // Tabs out of view stop re-rendering until they are shown again.
        freezeOnBlur: true,
        tabBarActiveTintColor: c.text,
        tabBarInactiveTintColor: c.textSecondary,
        tabBarStyle: {
          backgroundColor: c.background,
          borderTopColor: c.border,
          borderTopWidth: 1,
          elevation: 0,
          shadowOpacity: 0,
          shadowColor: 'transparent',
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '500',
        },
      }}
    >
      <Tab.Screen
        name="Mail"
        options={{
          title: tabLabels.mail,
          tabBarIcon: ({ color, size }) => <Mail size={size} color={color} />,
          tabBarBadge: inboxUnreadCount > 0 ? (inboxUnreadCount > 99 ? '99+' : inboxUnreadCount) : undefined,
          tabBarBadgeStyle: {
            backgroundColor: c.error,
            color: c.primaryForeground,
            fontSize: 10,
            fontWeight: '700',
            minWidth: 16,
            height: 16,
            lineHeight: 16,
            borderRadius: 8,
            top: -2,
            right: -6,
          },
        }}
      >
        {() => (
          <EmailListScreen
            onComposePress={() => navigation.navigate('Compose')}
            onEmailPress={(email) => {
              // The list holds the open folder's mail: name its account so the
              // viewer never has to guess it from whatever folder is open.
              const { mailboxes: all, currentMailboxId } = useEmailStore.getState();
              const target = {
                jmapAccountId: mailboxAccountId(all, currentMailboxId),
                // A row of an "All folders" list or a tag view names its own
                // account instead, and pages over that account's rows.
                ...viewerParamsForRow(email),
              };
              // Start on the body now: mounting the viewer takes a while.
              prefetchMessage(email, target.jmapAccountId);
              navigation.navigate('EmailThread', {
                emailId: email.id,
                threadId: email.threadId,
                subject: email.subject,
                ...target,
              });
            }}
          />
        )}
      </Tab.Screen>
      <Tab.Screen
        name="Calendar"
        component={CalendarScreen}
        options={{
          title: tabLabels.calendar,
          tabBarIcon: ({ color, size }) => <Calendar size={size} color={color} />,
          tabBarItemStyle: hasCalendar ? undefined : disabledTabStyle,
          tabBarAccessibilityLabel: hasCalendar ? tabLabels.calendar : unavailable(tabLabels.calendar),
        }}
        listeners={{
          tabPress: (e) => {
            if (!hasCalendar) e.preventDefault();
          },
        }}
      />
      <Tab.Screen
        name="Contacts"
        component={ContactsScreen}
        options={{
          title: tabLabels.contacts,
          tabBarIcon: ({ color, size }) => <BookUser size={size} color={color} />,
          tabBarItemStyle: hasContacts ? undefined : disabledTabStyle,
          tabBarAccessibilityLabel: hasContacts ? tabLabels.contacts : unavailable(tabLabels.contacts),
        }}
        listeners={{
          tabPress: (e) => {
            if (!hasContacts) e.preventDefault();
          },
        }}
      />
      <Tab.Screen
        name="Files"
        component={FilesScreen}
        options={{
          title: tabLabels.files,
          tabBarIcon: ({ color, size }) => <HardDrive size={size} color={color} />,
          tabBarItemStyle: hasFiles ? undefined : disabledTabStyle,
          tabBarAccessibilityLabel: hasFiles ? tabLabels.files : unavailable(tabLabels.files),
        }}
        listeners={{
          tabPress: (e) => {
            if (!hasFiles) e.preventDefault();
          },
        }}
      />
      <Tab.Screen
        name="Settings"
        options={{
          title: tabLabels.settings,
          tabBarIcon: ({ color, size }) => <Settings size={size} color={color} />,
        }}
      >
        {() => <SettingsScreen onLogout={() => { void signOutWithGuard(useAuthStore.getState().activeAccountId, () => navigation.navigate('Outbox')); }} />}
      </Tab.Screen>
    </Tab.Navigator>
    </View>
  );
}

export default function App() {
  const hasRestoredSession = useAuthStore((state) => state.hasRestoredSession);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const client = useAuthStore((state) => state.client);
  const restoreSession = useAuthStore((state) => state.restoreSession);
  const t = useLocaleStore((state) => state.t);

  // Resolve the user's theme preference to a concrete light/dark style for the
  // system status bar. The rest of the app's colors are still hard-coded dark
  // until the StyleSheet migration to a theme-aware `useColors` hook lands.
  const themePref = useSettingsStore((state) => state.theme);
  const systemScheme = useColorScheme();
  const resolvedScheme: 'light' | 'dark' =
    themePref === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : themePref;
  const statusBarStyle: 'light' | 'dark' = resolvedScheme === 'light' ? 'dark' : 'light';
  // React Navigation's default theme is light: without this its containers
  // paint white behind and between screens, even in dark mode.
  const background = useColors().background;
  const navigationTheme = React.useMemo(() => {
    const base = resolvedScheme === 'light' ? DefaultTheme : DarkTheme;
    return { ...base, colors: { ...base.colors, background, card: background } };
  }, [resolvedScheme, background]);
  // Persisted active account is the signal that the user was already signed
  // in on the previous launch. When present we render the main UI with the
  // cached mail list instead of the "Restoring session" spinner; the real
  // JMAP session comes up in the background.
  const hasPersistedAccount = useAccountStore((state) => state.activeAccountId != null);

  React.useEffect(() => {
    if (!hasRestoredSession) {
      void restoreSession();
    }
  }, [hasRestoredSession, restoreSession]);

  React.useEffect(() => {
    void useSettingsStore.getState().hydrate();
    void useLocaleStore.getState().hydrate();
    // Calendar reminders are kept scheduled from launch, not only once the
    // Calendar tab has been opened.
    startCalendarNotificationSync();
    // Device sync (Android, #34): live changes, the app's own edits and the
    // foreground ask Android to sync; accounts are checked against Android's.
    startDeviceSyncTriggers();
    return useNetworkStore.getState().init();
  }, []);

  // Home-screen widgets follow the signed-in data; once the last account is
  // gone they are wiped so no mail stays visible on the launcher.
  React.useEffect(() => {
    if (isAuthenticated) return startWidgetSync();
    if (hasRestoredSession) void signOutWidgets();
    return undefined;
  }, [isAuthenticated, hasRestoredSession]);

  // When the network flips back on while we're authenticated-but-offline
  // (no live JMAP session), retry the session so the user lands back on
  // live data without needing to relaunch. The online edge alone is not
  // enough: a cold start while the LAN server restarts leaves no session and
  // no edge to come, so keep retrying on a backoff (5 s doubling to 60 s)
  // while an interface is up, and at once when the app comes to the
  // foreground (lib/session-retry). retrySession is single-flight.
  React.useEffect(() => {
    if (!isAuthenticated) return;
    const retrier = startSessionRetry({
      shouldRetry: () => {
        const auth = useAuthStore.getState();
        return shouldRetrySession({
          isAuthenticated: auth.isAuthenticated,
          hasSession: auth.session != null,
          connected: useNetworkStore.getState().connected,
          isLoading: auth.isLoading,
        });
      },
      retry: () => useAuthStore.getState().retrySession(),
    });
    retrier.poke();
    const unsubscribers = [
      useNetworkStore.subscribe((state, prev) => {
        if (state.online && !prev.online && !useAuthStore.getState().session) {
          void useAuthStore.getState().retrySession();
        }
        if (state.connected !== prev.connected) retrier.poke();
      }),
      useAuthStore.subscribe((state, prev) => {
        if (state.session !== prev.session || state.isLoading !== prev.isLoading) retrier.poke();
      }),
    ];
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') retrier.kick();
    });
    return () => {
      retrier.stop();
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      appStateSubscription.remove();
    };
  }, [isAuthenticated]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const store = useUpdatesStore.getState();
      await store.hydrate();
      if (cancelled) return;
      if (useUpdatesStore.getState().autoCheck) {
        await useUpdatesStore.getState().checkNow();
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Offline mail cache: hydrate the cache index on launch, and kick off a
  // background sync once we have a live JMAP session and the user has the
  // feature enabled. Re-runs whenever the user changes the days window.
  const offlineCacheEnabled = useSettingsStore((s) => s.offlineCacheEnabled);
  const offlineCacheDays = useSettingsStore((s) => s.offlineCacheDays);
  const offlineCacheMaxMB = useSettingsStore((s) => s.offlineCacheMaxMB);
  const haveLiveSession = useAuthStore((s) => s.session != null);
  React.useEffect(() => {
    void useOfflineCacheStore.getState().hydrate();
    // Attachments shared out of the app linger in the cache dir; drop the
    // ones older than a day so a granted content URI can't read them forever.
    void sweepStaleExportFiles();
  }, []);
  React.useEffect(() => {
    if (!offlineCacheEnabled || !haveLiveSession) return;
    // Slight delay so cold start doesn't compete with the inbox load.
    const t = setTimeout(() => {
      void runOfflineSync({ days: offlineCacheDays, maxMB: offlineCacheMaxMB });
    }, 2000);
    return () => clearTimeout(t);
  }, [offlineCacheEnabled, offlineCacheDays, offlineCacheMaxMB, haveLiveSession]);

  // Drain the offline action queue (outbox) as soon as we have a live session,
  // and again whenever the network comes back. The flush itself no-ops when
  // there's nothing queued or the client isn't ready.
  // The offline send queue replays at the same points (it hydrates the active
  // account itself and waits while the client serves another account), plus
  // when a new session or active account lands and right after an enqueue.
  React.useEffect(() => {
    if (!haveLiveSession) return;
    void useOutboxStore.getState().flush();
    void flushSendQueue();
    const unsubscribers = [
      useNetworkStore.subscribe((state, prev) => {
        if (state.online && !prev.online) {
          void useOutboxStore.getState().flush();
          void flushSendQueue();
        }
      }),
      useAuthStore.subscribe((state, prev) => {
        if (state.session && state.session !== prev.session) void flushSendQueue();
      }),
      useAccountStore.subscribe((state, prev) => {
        if (state.activeAccountId !== prev.activeAccountId) void flushSendQueue();
      }),
      useSendQueueStore.subscribe((state, prev) => {
        if (useNetworkStore.getState().online && hasNewEntry(state.entries, prev.entries)) void flushSendQueue();
      }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [haveLiveSession]);

  // One toast per send that ended up failed or uncertain, and the Outbox
  // badge counts: load every account's queue so both see all of it.
  const accountIds = useAccountStore((s) => s.accounts.map((a) => a.id).join('\n'));
  React.useEffect(() => {
    if (!isAuthenticated) return;
    for (const a of useAccountStore.getState().accounts) {
      void useSendQueueStore.getState().hydrateAccount(a.id).catch(() => undefined);
    }
  }, [isAuthenticated, accountIds]);
  React.useEffect(() => {
    if (!isAuthenticated) return;
    return startOutboxToasts(() => {
      if (navigationRef.isReady()) navigationRef.navigate('Outbox' as never);
    });
  }, [isAuthenticated]);

  // Toasts for invitations the server delivered (queued by the store).
  React.useEffect(() => {
    if (!isAuthenticated) return;
    return startCalendarEventNotificationToasts(() => {
      if (navigationRef.isReady()) navigationRef.navigate('MainTabs', { screen: 'Calendar' } as never);
    });
  }, [isAuthenticated]);

  // Foreground FCM messages: the Kotlin service skips the headless task while
  // the app is visible, so feed the relay's StateChange straight into the
  // stores. SSE normally beats it, but this covers the window where the SSE
  // socket is down and the poll fallback has not fired yet.
  React.useEffect(() => {
    const unsubscribe = addMessageListener((payload) => {
      const raw = payload?.data?.changed;
      if (!raw) return;
      try {
        const changed = JSON.parse(raw) as Record<string, Record<string, string>>;
        if (!changed || typeof changed !== 'object') return;
        const change = { '@type': 'StateChange' as const, changed };
        dispatchStateChange(change);
        void useEmailStore.getState().handleStateChange(change);
      } catch {
        // malformed payload - ignore
      }
    });
    return unsubscribe;
  }, []);

  // When the user taps a notification the app lands here with an email id
  // either stashed on the cold-start intent or delivered as a live event.
  // Wait until auth is restored so the navigation target has credentials to
  // load the thread.
  React.useEffect(() => {
    if (!isAuthenticated) return;

    let cancelled = false;
    void (async () => {
      const initial = await getInitialNotificationTap();
      if (cancelled || !initial) return;
      await navigateToNotificationTap(initial);
    })();

    const unsubscribe = addNotificationTapListener((payload) => {
      void navigateToNotificationTap(payload);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isAuthenticated]);

  // Calendar reminders are local expo notifications; their taps come through
  // expo-notifications, not the native tap store used for mail push above.
  React.useEffect(() => {
    if (!isAuthenticated) return;
    return startCalendarReminderTapHandling((target) => {
      void openCalendarReminder(target);
    });
  }, [isAuthenticated]);

  // Deep links and share-sheet payloads. The cold-start URL / share is read
  // once auth is restored so the target screen has credentials.
  React.useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    const open = (link: DeepLink | null) => {
      if (!link || cancelled) return;
      // Give the navigator a tick to mount after the auth gate flips.
      setTimeout(() => { void openDeepLink(link); }, 50);
    };
    void Linking.getInitialURL().then((url) => open(url ? parseDeepLink(url) : null));
    void getInitialShare().then((share) => {
      if (!share) return;
      const link = shareToDeepLink(share);
      if (link.kind === 'compose' && share.uris?.length) {
        navigationRef.isReady() && navigationRef.navigate('Compose', {
          prefillTo: link.to,
          prefillSubject: link.subject,
          prefillBody: link.body,
          prefillAttachments: shareAttachments(share),
        });
        return;
      }
      open(link);
    });
    const urlSub = Linking.addEventListener('url', ({ url }) => open(parseDeepLink(url)));
    const shareSub = addShareListener((share) => {
      const link = shareToDeepLink(share);
      if (link.kind === 'compose' && share.uris?.length && navigationRef.isReady()) {
        navigationRef.navigate('Compose', {
          prefillTo: link.to,
          prefillSubject: link.subject,
          prefillBody: link.body,
          prefillAttachments: shareAttachments(share),
        });
        return;
      }
      open(link);
    });
    return () => {
      cancelled = true;
      urlSub.remove();
      shareSub();
    };
  }, [isAuthenticated]);

  // Sign-in links (`bulwarkmail://pair?…` from the webmail's Link Mobile App,
  // `bulwarkmail://connect?…`) work signed out too, so unlike the links above
  // they are listened for from launch. They are parked for the login screen
  // (the signed-out one takes them as it mounts), marked as coming from
  // outside the app: any page or app can fire one, so the login screen asks
  // before it redeems or opens anything.
  React.useEffect(() => {
    if (!initialSignInLinkRead) {
      initialSignInLinkRead = true;
      void Linking.getInitialURL().then((url) => { acceptSignInLink(url); }).catch(() => undefined);
    }
    const subscription = Linking.addEventListener('url', ({ url }) => { acceptSignInLink(url); });
    return () => subscription.remove();
  }, []);

  // Signed in, a sign-in link adds an account: open Add account, whose login
  // screen takes the parked link (or says why a refused one won't be used).
  // On a cold start the navigator mounts right after the auth gate flips, so
  // wait for it like a reminder tap does.
  const signInLinkPending = usePendingSignInLinkStore((s) => s.pending !== null || s.refusal !== null);
  const addAccountForLink = isAuthenticated && signInLinkPending;
  React.useEffect(() => {
    if (!addAccountForLink) return;
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 50 && !navigationRef.isReady(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (cancelled) return;
      }
      if (cancelled || !navigationRef.isReady()) return;
      const route = routeParkedSignInLink(useAccountStore.getState().accounts.length);
      if (route === 'account-limit') {
        // Said like the Add account buttons say it, instead of opening a
        // screen whose sign-in can only fail.
        const t = useLocaleStore.getState().t;
        toast.error(
          t('settings.account.accounts.limit', 'Maximum of {count} accounts reached.', { count: MAX_ACCOUNTS }),
          t('login.mobile.err_account_limit_detail', 'Remove an account in Settings to add another one.'),
        );
        return;
      }
      if (route === 'add-account') navigationRef.navigate('AddAccount');
    })();
    return () => { cancelled = true; };
  }, [addAccountForLink]);

  // Re-register the device with the configured relay once authenticated,
  // and whenever the FCM token rotates. Honours the user's notification
  // preference - flipping it off tears down THIS account's subscription so
  // notifications stop arriving for it. Other logged-in accounts keep their
  // setups intact. An account the user turned push off for, or whose device
  // registration was revoked, stays off (see resyncPushNotifications).
  const emailNotificationsEnabled = useSettingsStore(
    (s) => s.emailNotificationsEnabled,
  );
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  React.useEffect(() => {
    if (!isAuthenticated || !client) return;

    let cancelled = false;
    const doSetup = async () => {
      if (!emailNotificationsEnabled) {
        if (activeAccountId) {
          await teardownPushNotificationsForAccount(activeAccountId).catch(
            () => undefined,
          );
        }
        return;
      }
      const relayBaseUrl = await getStoredRelayBaseUrl();
      if (!relayBaseUrl) return;
      try {
        await resyncPushNotifications({
          relayBaseUrl,
          accountLabel: client.username ?? undefined,
        });
        // Brought up to date just now: the renewal below can skip it.
        if (activeAccountId) markPushRenewed(activeAccountId);
        if (cancelled) return;
      } catch (error) {
        console.warn(
          '[push] relay setup failed:',
          error instanceof Error ? error.message : error,
        );
      }
    };

    // Renew every account's subscription before Stalwart's 7-day expiry: once
    // the setup above has settled, and on every return to the foreground
    // (push-renewal throttles it to once a day per account).
    const setupDone = doSetup();
    const renew = () => {
      void setupDone.then(() => renewPushOnResume()).catch((error: unknown) => {
        console.warn('[push] renewal failed:', error instanceof Error ? error.message : error);
      });
    };
    renew();
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') renew();
    });
    const unsubscribe = addTokenRefreshListener(() => {
      void doSetup();
    });
    // UnifiedPush equivalent of an FCM token rotation: the distributor handed
    // out a new endpoint, so re-register it with the relay.
    const unsubscribeUp = addUnifiedPushEndpointListener(() => {
      void doSetup();
    });

    return () => {
      cancelled = true;
      appStateSubscription.remove();
      unsubscribe();
      unsubscribeUp();
    };
  }, [client, isAuthenticated, emailNotificationsEnabled, activeAccountId]);

  // "Inbox only" changes the delivery filter held on the server subscription.
  React.useEffect(() => {
    if (!isAuthenticated || !client) return;
    return watchInboxOnlyChange();
  }, [client, isAuthenticated]);

  // Live updates (SSE with polling fallback), re-armed on every account
  // switch and every re-established session — the singleton `client` object
  // never changes identity, so it cannot be the dependency on its own.
  // Backgrounding closes the stream (no socket + server pings while the app
  // is asleep); foregrounding reconnects it and refreshes what the user is
  // looking at, since events that happened in between are gone for good.
  React.useEffect(() => {
    if (!isAuthenticated || !client || !haveLiveSession) {
      return;
    }

    let mounted = true;
    let handle: LiveUpdatesHandle | null = null;
    let appActive = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';

    const onStateChange = async (change: StateChange) => {
      // Filters / vacation edited elsewhere (webmail, another device): refetch
      // so the settings panes don't save stale state over the newer script.
      const primary = (() => { try { return jmapClient.accountId; } catch { return null; } })();
      const own = primary ? change.changed?.[primary] : undefined;
      const extra: Promise<unknown>[] = [];
      if (own?.SieveScript) extra.push(useFilterStore.getState().fetchFilters().catch(() => undefined));
      if (own?.VacationResponse) extra.push(useVacationStore.getState().fetch().catch(() => undefined));
      dispatchStateChange(change);
      await Promise.all([
        useEmailStore.getState().handleStateChange(change),
        useContactsStore.getState().handleStateChange(change),
        useCalendarStore.getState().handleStateChange(change),
        ...extra,
      ]);
    };

    const start = async () => {
      try {
        const next = await startLiveUpdates({
          onStateChange: (change) => { void onStateChange(change); },
          onError: (error) => { console.warn('[push]', error.message); },
          onFallback: (reason) => { console.warn('[push] falling back to polling:', reason); },
          isActive: () => appActive,
        });
        if (!mounted) {
          next.close();
          return;
        }
        handle = next;
      } catch (error) {
        console.warn(error instanceof Error ? error.message : 'Failed to start JMAP push updates');
      }
    };

    const refreshAfterResume = () => {
      const email = useEmailStore.getState();
      void email.fetchMailboxes();
      if (email.currentMailboxId) void email.refreshEmails();
      void useOutboxStore.getState().flush();
      void flushSendQueue();
      void useCalendarEventNotificationStore.getState().fetch();
    };

    // Foreground liveness for the per-account connection dot: the open
    // stream's pings, or a `Core/echo` every 30 s while there is none (see
    // startLivenessMonitor). NetInfo cannot tell an unreachable server.
    const liveness = startLivenessMonitor({
      ping: () => jmapClient.ping(),
      streamHealthy: () => handle?.healthy ?? false,
      isActive: () => appActive,
      // An interface, not `online`: the echo is itself how a reachable server
      // is found again when the internet probe fails.
      isOnline: () => useNetworkStore.getState().connected,
      onConnected: (connected) => {
        if (!mounted || !activeAccountId) return;
        const account = useAccountStore.getState().getAccountById(activeAccountId);
        if (account && account.isConnected !== connected) {
          useAccountStore.getState().updateAccount(activeAccountId, { isConnected: connected });
        }
      },
    });

    void start();

    // Invitations, updates and cancellations the server delivered: pull once
    // now (sign-in or account switch re-runs this effect), then on a push for
    // the account we serve.
    void useCalendarEventNotificationStore.getState().fetch();
    const unsubscribeNotices = onStateChangeType('CalendarEventNotification', (changedAccountId) => {
      const primary = (() => { try { return jmapClient.accountId; } catch { return null; } })();
      if (changedAccountId === primary) void useCalendarEventNotificationStore.getState().fetch();
    });

    const subscription = AppState.addEventListener('change', (state) => {
      const nowActive = state === 'active';
      if (nowActive === appActive) return;
      appActive = nowActive;
      if (!nowActive) {
        handle?.close();
        handle = null;
        return;
      }
      // Coming back: reconnect and catch up on what was missed at once;
      // one echo alongside checks the server for the connection dot.
      if (!handle) void start();
      else handle.reconnect();
      refreshAfterResume();
      void liveness.check();
    });

    // Reconnect when the network comes back while foregrounded.
    const unsubscribeNetwork = useNetworkStore.subscribe((state, prev) => {
      if (state.online && !prev.online && appActive) {
        if (handle) handle.reconnect();
        else void start();
      }
    });

    return () => {
      mounted = false;
      unsubscribeNotices();
      subscription.remove();
      unsubscribeNetwork();
      liveness.stop();
      handle?.close();
      handle = null;
    };
  }, [client, isAuthenticated, haveLiveSession, activeAccountId]);

  // Skip the "Restoring session" flash for returning users: if we already
  // have a persisted active account, render the main UI immediately with
  // whatever the email-store hydrated from cache. restoreSession still runs
  // in the background and swaps in fresh data once it completes.
  if (!hasRestoredSession && !hasPersistedAccount) {
    return (
      <>
        <StatusBar style={statusBarStyle} />
        <LoadingScreen message={t('common.loading', 'Loading...')} />
      </>
    );
  }

  if (hasRestoredSession && !isAuthenticated) {
    return (
      <>
        <StatusBar style={statusBarStyle} />
        <LoginScreen />
      </>
    );
  }

  return (
    <NavigationContainer ref={navigationRef} theme={navigationTheme}>
      <StatusBar style={statusBarStyle} />
      {/* On Fabric, native-stack keeps the screen right below the top live and
          freezes the ones further down. */}
      <Stack.Navigator screenOptions={{ headerShown: false, freezeOnBlur: true }} screenLayout={withHosts}>
        <Stack.Screen name="MainTabs" component={MainTabsNavigator} />
        <Stack.Screen name="EmailThread" component={EmailThreadScreen} />
        <Stack.Screen name="EmailSource" component={EmailSourceScreen} />
        <Stack.Screen
          name="Compose"
          component={ComposeScreen}
          options={{
            presentation: 'modal',
            animation: 'slide_from_bottom',
          }}
        />
        <Stack.Screen name="ContactDetail" component={ContactDetailScreen} />
        <Stack.Screen
          name="ContactForm"
          component={ContactFormScreen}
          options={{
            presentation: 'modal',
            animation: 'slide_from_bottom',
          }}
        />
        <Stack.Screen name="GroupDetail" component={GroupDetailScreen} />
        <Stack.Screen name="Scheduled" component={ScheduledScreen} />
        <Stack.Screen name="Outbox" component={OutboxScreen} />
        <Stack.Screen name="UnifiedInbox" component={UnifiedInboxScreen} />
        <Stack.Screen
          name="AddAccount"
          options={{
            presentation: 'modal',
            animation: 'slide_from_bottom',
          }}
        >
          {({ navigation }) => (
            <LoginScreen
              isAddMode
              onCancel={() => navigation.goBack()}
              onLogin={() => navigation.goBack()}
            />
          )}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  loadingText: {
    ...typography.body,
  },
});

