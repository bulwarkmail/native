/**
 * An action that waits (a prompt, a fetch, a second request) before it
 * writes must decide which account it acts for before the first wait, and
 * carry that value down to every write: reading the screen's account again
 * after the wait would pick up an account switched to meanwhile and let the
 * write through. `check` throws, for the caller to report, once the captured
 * account is no longer the one shown.
 *
 * `isShown` and `refuse` are the app's (`isShownAccount`, `AccountNotServedError`),
 * passed in so this stays free of the stores.
 */
export interface CapturedAccount {
  appAccountId: string | null | undefined;
}

export function createAccountCapture(isShown: (appAccountId: string | null | undefined) => boolean, refuse: () => Error) {
  return function withCapturedAccount<A extends CapturedAccount, R>(
    capture: () => A,
    act: (account: A, check: () => void) => R,
  ): R {
    const account = capture();
    return act(account, () => {
      if (!isShown(account.appAccountId)) throw refuse();
    });
  };
}
