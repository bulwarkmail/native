// Installs the reading font for the app's text (./reading-font-text). Imported
// first thing by index.ts, before any screen module copies `Text` out of
// react-native. Android and iOS bundle the fonts (./reading-fonts); on other
// platforms nothing is wrapped. The settings store is required after the wrapping, so
// nothing it loads can copy the plain Text first.

/* eslint-disable @typescript-eslint/no-require-imports */
import { Platform } from 'react-native';
import { setUiFontFamily, wrapNamedExports } from './reading-font-text';
import { uiFontFamily, uiFontsBundled } from './reading-fonts';

if (uiFontsBundled(Platform.OS)) {
  wrapNamedExports(require('react-native'), ['Text', 'TextInput']);
  const { useSettingsStore } = require('../stores/settings-store') as typeof import('../stores/settings-store');
  setUiFontFamily(uiFontFamily(useSettingsStore.getState().appFont, Platform.OS));
  useSettingsStore.subscribe((state, prev) => {
    if (state.appFont !== prev.appFont) setUiFontFamily(uiFontFamily(state.appFont, Platform.OS));
  });
}
