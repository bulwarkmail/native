import React from 'react';
import { ActivityIndicator, AppState, Linking, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { DarkTheme, DefaultTheme, NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { Mail, Calendar, BookUser, HardDrive, Settings } from 'lucide-react-native';

import { startLiveUpdates, type LiveUpdatesHandle } from './src/api/push-stream';
import { jmapClient } from './src/api/jmap-client';
import type { StateChange } from './src/api/types';
import { dispatchStateChange } from './src/lib/state-change-bus';
import { startCalendarNotificationSync } from './src/lib/calendar-notifications';
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
import UnifiedInboxScreen from './src/screens/UnifiedInboxScreen';
import { useAccountStore } from './src/stores/account-store';
import { useAuthStore } from './src/stores/auth-store';
import { useCalendarStore } from './src/stores/calendar-store';
import { useContactsStore } from './src/stores/contacts-store';
import { useEmailStore } from './src/stores/email-store';
import { mailboxAccountId } from './src/lib/mailbox-tree';
import { useHasCalendar, useHasContacts, useHasFiles } from './src/lib/capabilities';
import { useSettingsStore } from './src/stores/settings-store';
import { useLocaleStore } from './src/stores/locale-store';
import { useNetworkStore } from './src/stores/network-store';
import { useUpdatesStore } from './src/stores/updates-store';
import { UpdateBanner } from './src/components/UpdateBanner';
import { PushOnboardingPrompt } from './src/components/PushOnboardingPrompt';
import { ToastHost } from './src/components/ToastHost';
import { AppIconBadge } from './src/components/AppIconBadge';
import { getEmails } from './src/api/email';
import { handleDeepLink, parseDeepLink, shareToDeepLink, type DeepLink } from './src/navigation/linking';
import { addShareListener, getInitialShare, shareAttachments } from './src/lib/share-intent';
import { OfflineCacheBanner } from './src/components/OfflineCacheBanner';
import { useOfflineCacheStore } from './src/stores/offline-cache-store';
import { useOutboxStore } from './src/stores/outbox-store';
import { runOfflineSync } from './src/lib/offline-sync';
import { spacing, typography, type ThemePalette } from './src/theme/tokens';
import { useColors } from './src/theme/colors';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabsParamList>();
const navigationRef = createNavigationContainerRef<RootStackParamList>();

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

  navigationRef.navigate('EmailThread', {
    emailId: payload.emailId,
    threadId: payload.threadId,
    subject: payload.subject,
    // A group mailbox's message lives under another JMAP account (#839).
    jmapAccountId: notificationTapJmapAccountId(payload),
  });
}

// Deep links (bulwarkmobile://, webmail https permalinks, mailto:) and
// Android share-sheet payloads all end up here once the navigator is ready.
async function openDeepLink(link: DeepLink): Promise<void> {
  await handleDeepLink(link, {
    navigation: navigationRef,
    resolveThreadId: async (emailId) => {
      try {
        const [email] = await getEmails([emailId]);
        return email?.threadId ?? null;
      } catch {
        return null;
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
  const logout = useAuthStore((state) => state.logout);
  const hasCalendar = useHasCalendar();
  const hasContacts = useHasContacts();
  const hasFiles = useHasFiles();
  const disabledTabStyle = { opacity: 0.4 } as const;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <UpdateBanner />
      <OfflineCacheBanner />
      <PushOnboardingPrompt />
      <ToastHost />
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
              navigation.navigate('EmailThread', {
                emailId: email.id,
                threadId: email.threadId,
                subject: email.subject,
                jmapAccountId: mailboxAccountId(all, currentMailboxId),
              });
            }}
          />
        )}
      </Tab.Screen>
      <Tab.Screen
        name="Calendar"
        component={CalendarScreen}
        options={{
          tabBarIcon: ({ color, size }) => <Calendar size={size} color={color} />,
          tabBarItemStyle: hasCalendar ? undefined : disabledTabStyle,
          tabBarAccessibilityLabel: hasCalendar ? 'Calendar' : 'Calendar (unavailable)',
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
          tabBarIcon: ({ color, size }) => <BookUser size={size} color={color} />,
          tabBarItemStyle: hasContacts ? undefined : disabledTabStyle,
          tabBarAccessibilityLabel: hasContacts ? 'Contacts' : 'Contacts (unavailable)',
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
          tabBarIcon: ({ color, size }) => <HardDrive size={size} color={color} />,
          tabBarItemStyle: hasFiles ? undefined : disabledTabStyle,
          tabBarAccessibilityLabel: hasFiles ? 'Files' : 'Files (unavailable)',
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
          tabBarIcon: ({ color, size }) => <Settings size={size} color={color} />,
        }}
      >
        {() => <SettingsScreen onLogout={logout} />}
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
    return useNetworkStore.getState().init();
  }, []);

  // When the network flips back on while we're authenticated-but-offline
  // (no live JMAP session), retry the session so the user lands back on
  // live data without needing to relaunch.
  React.useEffect(() => {
    if (!isAuthenticated) return;
    return useNetworkStore.subscribe((state, prev) => {
      if (state.online && !prev.online && !useAuthStore.getState().session) {
        void useAuthStore.getState().retrySession();
      }
    });
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
  React.useEffect(() => {
    if (!haveLiveSession) return;
    void useOutboxStore.getState().flush();
    return useNetworkStore.subscribe((state, prev) => {
      if (state.online && !prev.online) void useOutboxStore.getState().flush();
    });
  }, [haveLiveSession]);

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
        void useEmailStore.getState().handleStateChange({ '@type': 'StateChange', changed });
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
        if (cancelled) return;
      } catch (error) {
        console.warn(
          '[push] relay setup failed:',
          error instanceof Error ? error.message : error,
        );
      }
    };

    void doSetup();
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
      unsubscribe();
      unsubscribeUp();
    };
  }, [client, isAuthenticated, emailNotificationsEnabled, activeAccountId]);

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
    };

    void start();

    const subscription = AppState.addEventListener('change', (state) => {
      const nowActive = state === 'active';
      if (nowActive === appActive) return;
      appActive = nowActive;
      if (!nowActive) {
        handle?.close();
        handle = null;
        return;
      }
      // Coming back: verify the session is still alive before trusting the
      // stream, then reconnect and catch up on what was missed.
      void (async () => {
        const alive = await jmapClient.ping().catch(() => false);
        if (!mounted) return;
        if (!alive && useNetworkStore.getState().online) {
          const ok = await useAuthStore.getState().retrySession().catch(() => false);
          if (!ok || !mounted) return;
        }
        if (!handle) await start();
        else handle.reconnect();
        refreshAfterResume();
      })();
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
      subscription.remove();
      unsubscribeNetwork();
      handle?.close();
      handle = null;
    };
  }, [client, isAuthenticated, haveLiveSession, activeAccountId]);

  // Foreground keep-alive: a `Core/echo` every 30 s tells us when the server
  // is unreachable even though the device is online (NetInfo cannot), and
  // drives the per-account connection dot.
  React.useEffect(() => {
    if (!isAuthenticated || !haveLiveSession || !activeAccountId) return;
    let cancelled = false;
    let failures = 0;
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      if (!useNetworkStore.getState().online) return;
      void jmapClient.ping().then((ok) => {
        if (cancelled) return;
        failures = ok ? 0 : failures + 1;
        const account = useAccountStore.getState().getAccountById(activeAccountId);
        if (!account) return;
        // One missed echo can be a blip; two in a row is a lost connection.
        const connected = failures < 2;
        if (account.isConnected !== connected) {
          useAccountStore.getState().updateAccount(activeAccountId, { isConnected: connected });
        }
      }).catch(() => undefined);
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isAuthenticated, haveLiveSession, activeAccountId]);

  // Skip the "Restoring session" flash for returning users: if we already
  // have a persisted active account, render the main UI immediately with
  // whatever the email-store hydrated from cache. restoreSession still runs
  // in the background and swaps in fresh data once it completes.
  if (!hasRestoredSession && !hasPersistedAccount) {
    return (
      <>
        <StatusBar style={statusBarStyle} />
        <LoadingScreen message="Loading..." />
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
      <Stack.Navigator screenOptions={{ headerShown: false, freezeOnBlur: true }}>
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

