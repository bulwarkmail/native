import { describe, expect, it } from 'vitest';
import { loginBackAction, type LoginBackState } from '../login-back';

const idle: LoginBackState = {
  busy: false,
  searching: false,
  scannerVisible: false,
  pasteVisible: false,
  historyLength: 2,
  canLeave: true,
};

describe('Back on the sign-in screen', () => {
  it('cancels a sign-in under way instead of swallowing the key (U-133)', () => {
    expect(loginBackAction({ ...idle, busy: true })).toBe('cancel');
  });

  it('cancels the server search', () => {
    expect(loginBackAction({ ...idle, searching: true })).toBe('cancel');
  });

  it('closes the scanner, then the paste dialog, then goes a step back', () => {
    expect(loginBackAction({ ...idle, scannerVisible: true })).toBe('close-scanner');
    expect(loginBackAction({ ...idle, pasteVisible: true })).toBe('close-paste');
    expect(loginBackAction(idle)).toBe('step-back');
  });

  it('leaves add-account from the first step, and lets the system have the key otherwise', () => {
    expect(loginBackAction({ ...idle, historyLength: 0 })).toBe('leave');
    expect(loginBackAction({ ...idle, historyLength: 0, canLeave: false })).toBe('exit');
  });
});
