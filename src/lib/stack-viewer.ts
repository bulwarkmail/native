// The message each viewer on the stack shows now, by route key. The viewer
// pages (swipe, Prev / Next) in its own state, not its params, so this is
// where the Mail tab finds the message to take into its pane when the window
// widens under the viewer (lib/use-message-pane).

const shown = new Map<string, string>();

export function setStackViewerMessage(routeKey: string, emailId: string | null): void {
  if (emailId) shown.set(routeKey, emailId);
  else shown.delete(routeKey);
}

export function stackViewerMessage(routeKey: string): string | undefined {
  return shown.get(routeKey);
}
