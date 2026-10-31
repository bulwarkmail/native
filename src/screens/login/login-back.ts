// What Android Back (and the on-screen back) does on the sign-in screen.
// While a sign-in or the server search runs, Back cancels it and returns to
// the step it started from (U-133); it used to be swallowed, which left a
// hung "Signing in" with no way out but killing the app.

export type LoginBackAction = 'cancel' | 'close-scanner' | 'close-paste' | 'step-back' | 'leave' | 'exit';

export interface LoginBackState {
  busy: boolean;
  searching: boolean;
  scannerVisible: boolean;
  pasteVisible: boolean;
  /** Steps behind the current one. */
  historyLength: number;
  /** Add-account mode with a way to close the screen. */
  canLeave: boolean;
}

export function loginBackAction(state: LoginBackState): LoginBackAction {
  if (state.busy || state.searching) return 'cancel';
  if (state.scannerVisible) return 'close-scanner';
  if (state.pasteVisible) return 'close-paste';
  if (state.historyLength > 0) return 'step-back';
  if (state.canLeave) return 'leave';
  return 'exit';
}
