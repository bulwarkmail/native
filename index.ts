import { createElement } from 'react';
import { AppRegistry } from 'react-native';
import { registerRootComponent } from 'expo';

import { pushBackgroundTask } from './src/lib/push-background-task';

// Runs in a fresh headless JS runtime when BulwarkPushTaskService is started
// from BulwarkMessagingService on an FCM data message. Must be registered
// before the native service tries to invoke the task.
AppRegistry.registerHeadlessTask('BulwarkPushTask', () => pushBackgroundTask);

// A headless push task evaluates this file too, so App is required when the
// UI first renders instead of imported above: importing it here would load
// every screen, store and icon before the task could run.
function Root() {
  const App = (require('./App') as typeof import('./App')).default;
  return createElement(App);
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => Root);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(Root);
