export interface ScrollLock {
  hold: () => () => void;
}

export function createScrollLock(onChange: (locked: boolean) => void): ScrollLock {
  let holders = 0;
  return {
    hold() {
      if (holders++ === 0) onChange(true);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        if (--holders === 0) onChange(false);
      };
    },
  };
}

export const NO_SCROLL_LOCK: ScrollLock = { hold: () => () => {} };
