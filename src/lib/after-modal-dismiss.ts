// iOS can't present a view controller (the photo picker, the camera, the
// document picker, a share sheet) while a React Native Modal is still
// dismissing: UIKit drops the request without an error and the picker never
// shows. A sheet whose option opens a picker has to wait until it is gone.
//
// run() keeps the action until flush(), which the Modal's onDismiss calls.
// A timer flushes too, in case onDismiss doesn't fire. Android has no such
// limit, so the action runs right away there.

export interface AfterDismissQueue {
  run(action: () => void): void;
  flush(): void;
}

export function createAfterDismissQueue(
  platform: string,
  fallbackMs = 600,
): AfterDismissQueue {
  let pending: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const action = pending;
    pending = null;
    action?.();
  };

  return {
    run(action) {
      if (platform !== 'ios') {
        action();
        return;
      }
      if (timer) clearTimeout(timer);
      pending = action;
      timer = setTimeout(flush, fallbackMs);
    },
    flush,
  };
}
