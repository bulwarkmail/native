// Opens something once a modal has finished going away. iOS can't present a
// second modal while the first is still sliding out, so the caller waits for
// the Modal's `onDismiss`; that callback is known not to fire every time on
// iOS, so a timer opens it anyway. Whichever comes first wins and clears the
// other.
export function createAfterDismiss<T>(
  open: (target: T) => void,
  timeoutMs = 700,
): { arm(target: T): void; dismissed(): void; cancel(): void } {
  let armed: { target: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    armed = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const fire = () => {
    const pending = armed;
    cancel();
    if (pending) open(pending.target);
  };

  return {
    arm(target) {
      cancel();
      armed = { target };
      timer = setTimeout(fire, timeoutMs);
    },
    dismissed: fire,
    cancel,
  };
}
