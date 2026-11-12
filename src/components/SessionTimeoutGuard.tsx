import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import Dialog from './Dialog';
import { useAuthStore } from '../stores/auth-store';
import { useAccountStore } from '../stores/account-store';
import { usePolicyStore } from '../stores/policy-store';
import { useLocaleStore } from '../stores/locale-store';
import {
  currentSessionLimits,
  endSessionForLimit,
  lastActivity,
  loadSessionMemory,
  noteActivity,
  sessionState,
  type SessionEndKind,
  type SessionLimits,
  type SessionState,
} from '../lib/session-limits';

/** Long waits are checked again (setTimeout overflows past ~24.8 days). */
const MAX_WAIT_MS = 60 * 60 * 1000;
/** How often the time of use is noted while the app is in the foreground. */
const ACTIVITY_NOTE_MS = 60 * 1000;

/**
 * The organisation's idle sign-out and maximum session length (webmail
 * components/session/session-timeout-guard.tsx). The app counts as in use
 * while in the foreground; the idle time runs from the moment it leaves it,
 * and a limit that ran out meanwhile ends the session when it comes back.
 * The maximum session length warns first, counting down; at zero the open
 * composers save their drafts and every account signs out through the
 * app's sign-out.
 */
export function SessionTimeoutGuard() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const logoutAll = useAuthStore((s) => s.logoutAll);
  const byAccount = usePolicyStore((s) => s.byAccount);
  const effective = usePolicyStore((s) => s.effective);
  const accounts = useAccountStore((s) => s.accounts);
  const t = useLocaleStore((s) => s.t);

  const [ready, setReady] = React.useState(false);
  const [limits, setLimits] = React.useState<SessionLimits | null>(null);
  const [state, setState] = React.useState<SessionState | null>(null);
  const [ending, setEnding] = React.useState(false);
  const [dismissedMax, setDismissedMax] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(Date.now());
  const endingRef = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    void loadSessionMemory().then(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    if (!isAuthenticated || !ready) {
      setLimits(null);
      return;
    }
    const next = currentSessionLimits();
    setLimits((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [isAuthenticated, ready, byAccount, effective, accounts]);

  const end = React.useCallback(async (kind: SessionEndKind) => {
    if (endingRef.current) return;
    endingRef.current = true;
    setEnding(true);
    try {
      await endSessionForLimit(kind, logoutAll);
    } finally {
      endingRef.current = false;
      setEnding(false);
    }
  }, [logoutAll]);

  // Look at the clock: now, at the warning, at the deadline, and when the app comes back.
  React.useEffect(() => {
    if (!limits || (!limits.idle && !limits.max)) {
      setState(null);
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const evaluate = (foreground: boolean) => {
      if (timer) clearTimeout(timer);
      timer = null;
      const at = Date.now();
      // The idle time runs from the last moment the app was in use.
      const next = sessionState(limits, lastActivity() ?? at, at);
      if (next.phase === 'expired' && next.kind) {
        setState(next);
        void end(next.kind);
        return;
      }
      if (foreground) noteActivity(at);
      const settled = foreground ? sessionState(limits, at, at) : next;
      setState(settled);
      setNow(at);
      if (settled.deadline === null || settled.warnFrom === null) return;
      let wakeAt = settled.phase === 'warning' ? Math.min(settled.deadline, at + 1000) : settled.warnFrom;
      // In use: noted every minute, so an app that is killed in the
      // foreground doesn't start the next time as idle since long ago.
      if (foreground && limits.idle) wakeAt = Math.min(wakeAt, at + ACTIVITY_NOTE_MS);
      timer = setTimeout(() => evaluate(AppState.currentState === 'active'), Math.min(Math.max(0, wakeAt - at), MAX_WAIT_MS));
    };
    evaluate(AppState.currentState === 'active');
    const sub = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active') evaluate(true);
      else noteActivity(Date.now());
    });
    return () => {
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [limits, end]);

  if (!isAuthenticated) return null;
  if (ending) {
    return (
      <Dialog
        visible
        title={t('session_limits.signing_out', 'Saving drafts and signing out…')}
        confirmText={t('session_limits.dismiss', 'OK')}
        confirmDisabled
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />
    );
  }
  // Only the maximum length warns in the foreground: the idle time can't run out there.
  if (!state || state.phase !== 'warning' || state.kind !== 'max' || state.deadline === null) return null;
  if (dismissedMax === state.deadline) return null;
  const seconds = Math.max(0, Math.ceil((state.deadline - now) / 1000));
  return (
    <Dialog
      visible
      title={t('session_limits.max_title', 'Your session is ending')}
      message={t(
        'session_limits.max_message',
        "Your organisation ends sessions {hours, plural, one {# hour} other {# hours}} after sign-in. You'll be signed out in {seconds, plural, one {# second} other {# seconds}}. Open messages are saved as drafts.",
        { hours: limits?.max?.hours ?? 0, seconds },
      )}
      confirmText={t('session_limits.dismiss', 'OK')}
      cancelText={t('session_limits.sign_out_now', 'Sign out now')}
      onConfirm={() => setDismissedMax(state.deadline)}
      onCancel={() => { void end('max'); }}
    />
  );
}
