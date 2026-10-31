/**
 * Whether an editor sheet takes its content afresh: only when it opens. A
 * new `content` while it is open (a store refresh) must not replace what the
 * user typed (#1162).
 */
export function seedsOnRender(wasVisible: boolean, visible: boolean): boolean {
  return visible && !wasVisible;
}
