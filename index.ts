import { AppRegistry } from 'react-native';
import { registerRootComponent } from 'expo';

import App from './App';
import { pushBackgroundTask } from './src/lib/push-background-task';

// Runs in a fresh headless JS runtime when BulwarkPushTaskService is started
// from BulwarkMessagingService on an FCM data message. Must be registered
// before the native service tries to invoke the task.
AppRegistry.registerHeadlessTask('BulwarkPushTask', () => pushBackgroundTask);

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
