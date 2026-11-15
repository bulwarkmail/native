import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { CommonActions } from '@react-navigation/native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * The tabs in the status column of an iPhone Duo (`tabBarPositionFor`
 * 'right'): its outer display, and the inner one turned sideways, keep the
 * status bar in a column down the right edge, and Apple puts the tab bar in
 * that column too, at its foot, below the status bar and any toolbar
 * ("Designing for iPhone Duo", Vertical controls). The column is the
 * window's right safe-area inset, which every screen keeps clear of already,
 * so the bar is drawn over it and takes no room from the screens.
 *
 * Rendered by the tab navigator in place of its bottom bar; it reads the same
 * tab options (icon, title, badge, label setting, accessibility label, test
 * id, hidden and unavailable tabs) and emits the same tabPress event. The
 * navigator's container already keeps clear of the bottom inset (App.tsx).
 */
export default function SideColumnTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const shown = state.routes.filter(
    (route) => StyleSheet.flatten(descriptors[route.key].options.tabBarItemStyle)?.display !== 'none',
  );
  return (
    <View role="tablist" style={[styles.column, { width: insets.right }]}>
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const itemStyle = StyleSheet.flatten(options.tabBarItemStyle);
        if (itemStyle?.display === 'none') return null;
        const focused = index === state.index;
        const color = (focused ? options.tabBarActiveTintColor : options.tabBarInactiveTintColor) ?? undefined;
        const label = typeof options.title === 'string' ? options.title : route.name;
        const badge = options.tabBarBadge;
        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) {
            navigation.dispatch({
              ...CommonActions.navigate({ name: route.name, params: route.params, merge: true }),
              target: state.key,
            });
          }
        };
        // As the stock iOS tab bar reads it ("Mail, tab, 1 of 5"), with the
        // unread count, which the badge inside the button would not give.
        const a11yLabel = options.tabBarAccessibilityLabel ?? (Platform.OS === 'ios'
          ? `${label}${badge != null ? `, ${badge}` : ''}, tab, ${shown.indexOf(route) + 1} of ${shown.length}`
          : label);
        const onLongPress = () => navigation.emit({ type: 'tabLongPress', target: route.key });
        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            onLongPress={onLongPress}
            role="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={a11yLabel}
            testID={options.tabBarButtonTestID}
            style={[styles.item, itemStyle]}
          >
            <View style={[styles.icon, focused && options.tabBarActiveBackgroundColor
              ? { backgroundColor: options.tabBarActiveBackgroundColor }
              : null]}
            >
              {options.tabBarIcon?.({ focused, color: color ?? '', size: ICON_SIZE })}
              {badge != null && (
                <Text style={[styles.badge, options.tabBarBadgeStyle]} numberOfLines={1}>{badge}</Text>
              )}
            </View>
            {options.tabBarShowLabel !== false && (
              // Longer names (Einstellungen, Paramètres) shrink to fit the column.
              <Text
                style={[styles.label, { color }, options.tabBarLabelStyle]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
              >
                {label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const ICON_SIZE = 24;
const COLUMN_PADDING = 8;

const styles = StyleSheet.create({
  // Over the right inset, which the screens leave empty; the status bar
  // stays above the tabs.
  column: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    paddingBottom: COLUMN_PADDING,
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 4,
  },
  item: { alignItems: 'center', justifyContent: 'center', minHeight: 52, alignSelf: 'stretch', paddingHorizontal: 2 },
  icon: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 14 },
  badge: { position: 'absolute', overflow: 'hidden', textAlign: 'center', paddingHorizontal: 4 },
  label: { marginTop: 2 },
});
