// Installs the reading font for the app's text (./reading-font-text). Imported
// first thing by index.ts, before any screen module copies `Text` out of
// react-native. Android only: iOS has no bundled reading fonts yet
// (./reading-fonts). The settings store is required after the wrapping, so
// nothing it loads can copy the plain Text first.

/* eslint-disable @typescript-eslint/no-require-imports */
import { Platform } from 'react-native';
import { setUiFontFamily, wrapModuleDefaults } from './reading-font-text';
import { uiFontFamily, uiFontsBundled } from './reading-fonts';

if (uiFontsBundled(Platform.OS)) {
  wrapModuleDefaults([
    require('react-native/Libraries/Text/Text'),
    require('react-native/Libraries/Components/TextInput/TextInput'),
  ]);
  const { useSettingsStore } = require('../stores/settings-store') as typeof import('../stores/settings-store');
  setUiFontFamily(uiFontFamily(useSettingsStore.getState().appFont, Platform.OS));
  useSettingsStore.subscribe((state, prev) => {
    if (state.appFont !== prev.appFont) setUiFontFamily(uiFontFamily(state.appFont, Platform.OS));
  });
}
