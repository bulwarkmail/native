// FlatList takes `strictMode` (see its FlatList.js), but only the generated
// strict API types (`react-native/types_generated`) declare it; the default
// typings this app compiles against lack it.
import 'react-native';

declare module 'react-native' {
  interface FlatListProps<ItemT> {
    /**
     * Memoize the item renderer FlatList hands its cells, so they re-render
     * only when `renderItem` (or `extraData`) changes rather than on every
     * render of the list.
     */
    strictMode?: boolean;
  }
}
