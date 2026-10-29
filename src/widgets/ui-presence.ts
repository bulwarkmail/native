// Whether the app's UI has started in this JS runtime. Widget and push tasks
// can start the runtime with no UI; until the UI starts, nothing else uses
// the app's `jmapClient` singleton, so a widget refresh may sign it in to
// the active account and load calendar and tasks with the app's own code.

let started = false;

/** Called when the UI renders for the first time (index.ts). */
export function markUiStarted(): void {
  started = true;
}

export function uiStarted(): boolean {
  return started;
}
