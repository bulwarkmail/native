import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * How far the content of a bottom sheet or dialog has to stay above the
 * screen bottom.
 *
 * Every RN Modal on Android is edge to edge here: with edge-to-edge on (Expo
 * SDK 54) the Modal forces statusBarTranslucent and navigationBarTranslucent,
 * so its window reaches under the navigation bar, a phone's gesture bar or a
 * tablet's taskbar. A sheet that ends at `bottom: 0` (or a backdrop that
 * aligns it with `justifyContent: 'flex-end'`) puts its last row under that
 * bar, where a tap goes to the taskbar instead (an app icon opened). The sheet
 * keeps its surface down to the screen edge and pads its content by this.
 *
 * Inside a plain Modal the insets come from the app's provider (React context
 * reaches into the Modal); inside a SafeAreaModal from the Modal's own.
 */
export function useSheetBottomInset(): number {
  return useSafeAreaInsets().bottom;
}
