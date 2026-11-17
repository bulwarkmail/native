import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * The root of a sign-in screen. Sign-in fills the window, so it pads by the
 * window's insets: as the first screen after a cold start the native
 * SafeAreaView applied none on iOS and the language button sat under the
 * status bar. Add account (`sheet`) is a sheet on iOS, whose own safe area
 * is not the window's, and keeps the native view.
 */
export default function LoginFrame({ sheet, style, children }: {
  sheet: boolean;
  style: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  if (sheet) return <SafeAreaView style={style}>{children}</SafeAreaView>;
  return (
    <View
      style={[style, { paddingTop: insets.top, paddingRight: insets.right, paddingBottom: insets.bottom, paddingLeft: insets.left }]}
    >
      {children}
    </View>
  );
}
