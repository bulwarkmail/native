import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * The inside of a side drawer, kept clear of the status bar, the home
 * indicator and the left edge. The padding comes from the provider's insets,
 * which are known on the first render (a new provider starts with its
 * parent's). The native SafeAreaView only learned them a few frames later on
 * Fabric, and every time the drawer opened: its header first drew under the
 * status bar or Dynamic Island and then jumped down, while the drawer was
 * still sliding in.
 */
export function DrawerPanel({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[style, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left }]}>
      {children}
    </View>
  );
}
