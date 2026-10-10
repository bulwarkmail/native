import { createElement } from 'react';
import { AppRegistry } from 'react-native';
import { registerRootComponent } from 'expo';
import { registerWidgetTaskHandler } from 'react-native-android-widget';

import { pushBackgroundTask } from './src/lib/push-background-task';
import { widgetTaskHandler } from './src/widgets/task-handler';
import { refreshWidgetsInBackground } from './src/widgets/sync';
import { markUiStarted } from './src/widgets/ui-presence';

// Runs in a fresh headless JS runtime when BulwarkPushTaskService is started
// from BulwarkMessagingService on an FCM data message. Must be registered
// before the native service tries to invoke the task. New mail also refreshes
// any home-screen widgets (a no-op when none are placed).
AppRegistry.registerHeadlessTask('BulwarkPushTask', () => async (data: Parameters<typeof pushBackgroundTask>[0]) => {
  await Promise.allSettled([pushBackgroundTask(data), refreshWidgetsInBackground()]);
});

// Notification quick actions (Mark as read, Delete): run without launching the app UI.
AppRegistry.registerHeadlessTask('BulwarkNotificationAction', () => async (data: unknown) => {
  const { handleNotificationAction } = require('./src/lib/push-background-task') as typeof import('./src/lib/push-background-task');
  await Promise.allSettled([handleNotificationAction(data), refreshWidgetsInBackground()]);
});

// Device sync (Android, #34): the contacts and calendar sync adapters run the
// sync engine through this task, headless or next to the UI. The engine is
// required on first use so an app start does not load it.
AppRegistry.registerHeadlessTask('BulwarkDeviceSync', () => async (data: import('./src/device-sync/types').RunPayload) => {
  const { runDeviceSyncTask } = require('./src/device-sync/task') as typeof import('./src/device-sync/task');
  await runDeviceSyncTask(data);
});

// Home-screen widgets (Android): every widget event runs this headless task.
registerWidgetTaskHandler(widgetTaskHandler);
// ...and leaving the app refreshes them in one (BulwarkWidgetRefreshService).
AppRegistry.registerHeadlessTask('BulwarkWidgetRefresh', () => refreshWidgetsInBackground);

// A headless push task evaluates this file too, so App is required when the
// UI first renders instead of imported above: importing it here would load
// every screen, store and icon before the task could run.
function Root() {
  markUiStarted();
  const App = (require('./App') as typeof import('./App')).default;
  return createElement(App);
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => Root);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(Root);
