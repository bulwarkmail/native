import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { Mail, Calendar, BookUser, HardDrive, Settings } from 'lucide-react-native';

import { startPushUpdates } from './src/api/push';
import {
  addMessageListener,
  addNotificationTapListener,
  addTokenRefreshListener,
  getInitialNotificationTap,
  getStoredRelayBaseUrl,
  setupPushNotifications,
  teardownPushNotificationsForAccount,
  type NotificationTapPayload,
} from './src/lib/push-notifications';
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
import { useAccountStore } from './src/stores/account-store';
import { useAuthStore } from './src/stores/auth-store';
import { useCalendarStore } from './src/stores/calendar-store';
import { useContactsStore } from './src/stores/contacts-store';
import { useEmailStore } from './src/stores/email-store';
import { useHasCalendar, useHasContacts, useHasFiles } from './src/lib/capabilities';
import { useSettingsStore } from './src/stores/settings-store';
import { useLocaleStore } from './src/stores/locale-store';
import { useNetworkStore } from './src/stores/network-store';
import { useUpdatesStore } from './src/stores/updates-store';
import { UpdateBanner } from './src/components/UpdateBanner';
import { OfflineCacheBanner } from './src/components/OfflineCacheBanner';
import { useOfflineCacheStore } from './src/stores/offline-cache-store';
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
  const mailboxes = useEmailStore((state) => state.mailboxes);
  const logout = useAuthStore((state) => state.logout);
  const inboxUnreadCount = mailboxes.find((mailbox) => mailbox.role === 'inbox')?.unreadEmails ?? 0;
  const hasCalendar = useHasCalendar();
  const hasContacts = useHasContacts();
  const hasFiles = useHasFiles();
  const disabledTabStyle = { opacity: 0.4 } as const;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <UpdateBanner />
      <OfflineCacheBanner />
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
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
              navigation.navigate('EmailThread', {
                emailId: email.id,
                threadId: email.threadId,
                subject: email.subject,
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
  const haveLiveSession = useAuthStore((s) => s.session != null);
  React.useEffect(() => {
    void useOfflineCacheStore.getState().hydrate();
  }, []);
  React.useEffect(() => {
    if (!offlineCacheEnabled || !haveLiveSession) return;
    // Slight delay so cold start doesn't compete with the inbox load.
    const t = setTimeout(() => {
      void runOfflineSync({ days: offlineCacheDays });
    }, 2000);
    return () => clearTimeout(t);
  }, [offlineCacheEnabled, offlineCacheDays, haveLiveSession]);

  // Listen for FCM messages so the app can refresh state even when woken
  // from the background - the FirebaseMessagingService also posts the system
  // notification so the user sees it regardless of RN runtime state.
  React.useEffect(() => {
    const unsubscribe = addMessageListener((payload) => {
      console.log('[push] fcm message', payload.title);
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

  // Re-register the device with the configured relay once authenticated,
  // and whenever the FCM token rotates. Honours the user's notification
  // preference - flipping it off tears down THIS account's subscription so
  // notifications stop arriving for it. Other logged-in accounts keep their
  // setups intact.
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
        await setupPushNotifications({
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

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, isAuthenticated, emailNotificationsEnabled, activeAccountId]);

  React.useEffect(() => {
    if (!isAuthenticated || !client) {
      return;
    }

    let mounted = true;
    let cleanup: (() => void) | null = null;

    void (async () => {
      try {
        const stopPushUpdates = await startPushUpdates(client, {
          onStateChange: async (change) => {
            await Promise.all([
              useEmailStore.getState().handleStateChange(change),
              useContactsStore.getState().handleStateChange(change),
              useCalendarStore.getState().handleStateChange(change),
            ]);
          },
          onError: (error) => {
            console.warn(error.message);
          },
        });

        if (!mounted) {
          stopPushUpdates();
          return;
        }

        cleanup = stopPushUpdates;
      } catch (error) {
        console.warn(error instanceof Error ? error.message : 'Failed to start JMAP push updates');
      }
    })();

    return () => {
      mounted = false;
      cleanup?.();
    };
  }, [client, isAuthenticated]);

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
    <NavigationContainer ref={navigationRef}>
      <StatusBar style={statusBarStyle} />
      <Stack.Navigator screenOptions={{ headerShown: false }}>
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

