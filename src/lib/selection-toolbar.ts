// The list's selection toolbar on a narrow list column. Up to seven 44 dp
// actions sit beside the close button and the count; in a tablet's portrait
// split view the list column is narrower than that, and Archive and Delete
// were drawn over the reading pane. The actions that don't fit go into a
// "More" menu, the least used first, so Archive and Delete stay on the bar.

/** Which actions to show on the bar and which to put in the "More" menu. */
export function fitToolbarActions<K extends string>(
  keys: readonly K[],
  opts: {
    /** The toolbar's measured width; null shows them all until it is known. */
    width: number | null;
    /** Room taken by everything that isn't an action (padding, close, count). */
    reserved: number;
    /** Width of one action button (and of the "More" button). */
    button: number;
    /** The actions to move into the menu, first to go first. */
    overflowOrder: readonly K[];
  },
): { visible: K[]; overflow: K[] } {
  if (opts.width === null) return { visible: [...keys], overflow: [] };
  const capacity = Math.max(0, Math.floor((opts.width - opts.reserved) / opts.button));
  if (keys.length <= capacity) return { visible: [...keys], overflow: [] };
  // One slot goes to the "More" button.
  const room = Math.max(0, capacity - 1);
  const order = [...opts.overflowOrder.filter((k) => keys.includes(k)), ...keys.filter((k) => !opts.overflowOrder.includes(k))];
  const moved = new Set(order.slice(0, keys.length - room));
  return {
    visible: keys.filter((k) => !moved.has(k)),
    overflow: keys.filter((k) => moved.has(k)),
  };
}
