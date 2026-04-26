import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
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
import { useSettingsStore } from './src/stores/settings-store';
import { useLocaleStore } from './src/stores/locale-store';
import { useUpdatesStore } from './src/stores/updates-store';
import { UpdateBanner } from './src/components/UpdateBanner';
import { colors, spacing, typography } from './src/theme/tokens';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabsParamList>();
const navigationRef = createNavigationContainerRef<RootStackParamList>();

function navigateToNotificationTap(payload: NotificationTapPayload): void {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate('EmailThread', {
    emailId: payload.emailId,
    threadId: payload.threadId,
    subject: payload.subject,
  });
}

function LoadingScreen({ message }: { message: string }) {
  return (
    <View style={styles.loadingContainer}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.loadingText}>{message}</Text>
    </View>
  );
}

function MainTabsNavigator({ navigation }: NativeStackScreenProps<RootStackParamList, 'MainTabs'>) {
  const mailboxes = useEmailStore((state) => state.mailboxes);
  const logout = useAuthStore((state) => state.logout);
  const inboxUnreadCount = mailboxes.find((mailbox) => mailbox.role === 'inbox')?.unreadEmails ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <UpdateBanner />
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        // Matches webmail horizontal NavigationRail: bg-background, border-t border-border,
        // active uses foreground (white), inactive uses muted-foreground.
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
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
            backgroundColor: colors.error,
            color: colors.primaryForeground,
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
        }}
      />
      <Tab.Screen
        name="Contacts"
        component={ContactsScreen}
        options={{
          tabBarIcon: ({ color, size }) => <BookUser size={size} color={color} />,
        }}
      />
      <Tab.Screen
        name="Files"
        component={FilesScreen}
        options={{
          tabBarIcon: ({ color, size }) => <HardDrive size={size} color={color} />,
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
  }, []);

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
      navigateToNotificationTap(initial);
    })();

    const unsubscribe = addNotificationTapListener((payload) => {
      navigateToNotificationTap(payload);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isAuthenticated]);

  // Re-register the device with the configured relay once authenticated,
  // and whenever the FCM token rotates.
  React.useEffect(() => {
    if (!isAuthenticated || !client) return;

    let cancelled = false;
    const doSetup = async () => {
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
  }, [client, isAuthenticated]);

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
        <StatusBar style="light" />
        <LoadingScreen message="Loading..." />
      </>
    );
  }

  if (hasRestoredSession && !isAuthenticated) {
    return (
      <>
        <StatusBar style="light" />
        <LoginScreen />
      </>
    );
  }

  return (
    <NavigationContainer ref={navigationRef}>
      <StatusBar style="light" />
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
    backgroundColor: colors.background,
    gap: spacing.md,
  },
  loadingText: {
    ...typography.body,
    color: colors.textSecondary,
  },
});

