import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { Mail, Calendar, BookUser, HardDrive, Settings } from 'lucide-react-native';

import { startPushUpdates } from './src/api/push';
import type { MainTabsParamList, RootStackParamList } from './src/navigation/types';
import ComposeScreen from './src/screens/ComposeScreen';
import EmailThreadScreen from './src/screens/EmailThreadScreen';
import LoginScreen from './src/screens/LoginScreen';
import EmailListScreen from './src/screens/EmailListScreen';
import FilesScreen from './src/screens/FilesScreen';
import CalendarScreen from './src/screens/CalendarScreenNew';
import ContactsScreen from './src/screens/ContactsScreenNew';
import SettingsScreen from './src/screens/SettingsScreenNew2';
import { useAuthStore } from './src/stores/auth-store';
import { useCalendarStore } from './src/stores/calendar-store';
import { useContactsStore } from './src/stores/contacts-store';
import { useEmailStore } from './src/stores/email-store';
import { colors, spacing, typography } from './src/theme/tokens';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabsParamList>();

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
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
          borderTopWidth: 1,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '600',
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
  );
}

export default function App() {
  const hasRestoredSession = useAuthStore((state) => state.hasRestoredSession);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const client = useAuthStore((state) => state.client);
  const restoreSession = useAuthStore((state) => state.restoreSession);

  React.useEffect(() => {
    if (!hasRestoredSession) {
      void restoreSession();
    }
  }, [hasRestoredSession, restoreSession]);

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

  if (!hasRestoredSession) {
    return (
      <>
        <StatusBar style="light" />
        <LoadingScreen message="Restoring session..." />
      </>
    );
  }

  if (!isAuthenticated) {
    return (
      <>
        <StatusBar style="light" />
        <LoginScreen />
      </>
    );
  }

  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="MainTabs" component={MainTabsNavigator} />
        <Stack.Screen name="EmailThread" component={EmailThreadScreen} />
        <Stack.Screen
          name="Compose"
          component={ComposeScreen}
          options={{
            presentation: 'modal',
            animation: 'slide_from_bottom',
          }}
        />
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
