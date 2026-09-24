import React from 'react';
import { BackHandler } from 'react-native';
import { useAuthStore } from '../stores/auth-store';
import { useAccountStore } from '../stores/account-store';
import { useLocaleStore } from '../stores/locale-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QrScanModal } from '../components/QrScanModal';
import { parseQrLoginPayload } from '../lib/oauth';
import {
  discoverServerForEmail,
  emailDomain,
  isEmailAddress,
  normalizeServerUrl,
} from '../lib/server-discovery';
import { describeLoginError, type LoginErrorCopy } from '../lib/login-errors';
import LoginShell from './login/LoginShell';
import ChooseStep from './login/ChooseStep';
import EmailStep from './login/EmailStep';
import ServerStep from './login/ServerStep';
import ConfirmStep from './login/ConfirmStep';
import PasswordStep from './login/PasswordStep';
import SigningInStep, { type SigningInPhase } from './login/SigningInStep';

interface LoginScreenProps {
  onLogin?: () => void;
  isAddMode?: boolean;
  onCancel?: () => void;
}

type StepName = 'choose' | 'email' | 'server' | 'confirm' | 'password';

const RECENT_EMAILS_KEY = 'login:recentEmails:v1';

/**
 * Sign-in, one question per screen, cheapest question first.
 *
 * The routes that need no server address — a paired QR code, or an email we
 * can discover a server from — come first; the manual server + password form
 * is the fallback rather than the greeting. Every step drives one of the
 * existing auth-store actions, so the credential handling below is unchanged
 * from the single-form version this replaced.
 */
export default function LoginScreen({ onLogin, isAddMode = false, onCancel }: LoginScreenProps) {
  const login = useAuthStore((state) => state.login);
  const loginViaWebmail = useAuthStore((state) => state.loginViaWebmail);
  const loginViaPairing = useAuthStore((state) => state.loginViaPairing);
  const clearError = useAuthStore((state) => state.clearError);
  const storeError = useAuthStore((state) => state.error);

  const t = useLocaleStore((state) => state.t);
  const accounts = useAccountStore((state) => state.accounts);
  const activeAccountId = useAccountStore((state) => state.activeAccountId);

  const [step, setStep] = React.useState<StepName>('choose');
  const [history, setHistory] = React.useState<StepName[]>([]);
  const [email, setEmail] = React.useState('');
  const [serverInput, setServerInput] = React.useState('');
  const [serverUrl, setServerUrl] = React.useState('');
  // Drives the confirm step's heading: we only claim to have "found" a server
  // when discovery actually found one.
  const [serverDiscovered, setServerDiscovered] = React.useState(false);
  const [password, setPassword] = React.useState('');
  // Second factor. Shown only after the server asked for it (402), so the
  // common no-2FA sign-in stays a two-field form.
  const [totp, setTotp] = React.useState('');
  const [totpRequired, setTotpRequired] = React.useState(false);
  const [failedDomain, setFailedDomain] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<LoginErrorCopy | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [busy, setBusy] = React.useState<SigningInPhase | null>(null);
  const [scannerVisible, setScannerVisible] = React.useState(false);

  // Addresses typed before on this device (last 5) plus the registry's, so a
  // returning user taps instead of retyping. Never contains passwords.
  const [recentEmails, setRecentEmails] = React.useState<string[]>([]);
  React.useEffect(() => {
    void AsyncStorage.getItem(RECENT_EMAILS_KEY).then((raw) => {
      try {
        const list = raw ? (JSON.parse(raw) as unknown) : [];
        if (Array.isArray(list)) setRecentEmails(list.filter((v): v is string => typeof v === 'string'));
      } catch {
        // ignore corrupt entry
      }
    }).catch(() => undefined);
  }, []);
  const emailSuggestions = React.useMemo(() => {
    const out: string[] = [];
    for (const v of [...recentEmails, ...accounts.map((a) => a.email || a.username)]) {
      if (v && v.includes('@') && !out.includes(v)) out.push(v);
    }
    return out;
  }, [recentEmails, accounts]);
  const rememberEmail = React.useCallback((address: string) => {
    const next = [address, ...recentEmails.filter((v) => v !== address)].slice(0, 5);
    setRecentEmails(next);
    void AsyncStorage.setItem(RECENT_EMAILS_KEY, JSON.stringify(next)).catch(() => undefined);
  }, [recentEmails]);

  // Servers we already hold credentials for. Discovery trusts these without a
  // probe, which makes "second account on the same host" instant.
  const knownServerUrls = React.useMemo(() => accounts.map((a) => a.serverUrl), [accounts]);
  const knownServerUrl = React.useMemo(() => {
    const active = accounts.find((a) => a.id === activeAccountId);
    return active?.serverUrl ?? accounts[0]?.serverUrl ?? null;
  }, [accounts, activeAccountId]);

  const goTo = React.useCallback(
    (next: StepName) => {
      clearError();
      setNotice(null);
      setHistory((prev) => [...prev, step]);
      setStep(next);
    },
    [clearError, step],
  );

  const goBack = React.useCallback(() => {
    if (history.length === 0) return;
    clearError();
    setNotice(null);
    setStep(history[history.length - 1]);
    setHistory((prev) => prev.slice(0, -1));
  }, [clearError, history]);

  // Android hardware back mirrors the on-screen back: one step at a time, and
  // out of the flow entirely from the first step.
  React.useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy || searching) return true;
      if (scannerVisible) {
        setScannerVisible(false);
        return true;
      }
      if (history.length > 0) {
        goBack();
        return true;
      }
      if (isAddMode && onCancel) {
        onCancel();
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [busy, searching, scannerVisible, history.length, goBack, isAddMode, onCancel]);

  // ── flows ──────────────────────────────────────────────

  const finishIfSignedIn = React.useCallback(
    (wasAuthenticated: boolean) => {
      const isAuthenticated = useAuthStore.getState().isAuthenticated;
      // In add mode the store was already authenticated before we started, so
      // the before/after comparison can't be the only signal.
      if ((isAuthenticated && !wasAuthenticated) || (isAddMode && isAuthenticated)) {
        onLogin?.();
        return true;
      }
      return false;
    },
    [isAddMode, onLogin],
  );

  const runHandoff = React.useCallback(
    async (target: string) => {
      setNotice(null);
      setBusy('browser');
      const wasAuthenticated = useAuthStore.getState().isAuthenticated;
      try {
        await loginViaWebmail(target, { addAccount: isAddMode });
        // loginViaWebmail resolves quietly when the user closes the browser —
        // that's a cancellation, not a failure, so leave them where they were.
        finishIfSignedIn(wasAuthenticated);
      } catch (err) {
        // The webmail hands back the password even when the account needs a
        // second factor; finish the sign-in here with a code instead of
        // failing (the user already proved the password once).
        const pending = useAuthStore.getState().pendingTotpLogin;
        if (err instanceof Error && err.name === 'TotpRequiredError' && pending) {
          setEmail(pending.username);
          setPassword(pending.password);
          setServerUrl(pending.serverUrl);
          setTotpRequired(true);
          setBusy(null);
          setNotice(describeLoginError(err, { serverUrl: target, t }));
          setHistory((prev) => [...prev, step]);
          setStep('password');
          return;
        }
        setNotice(describeLoginError(err, { serverUrl: target, t }));
      } finally {
        setBusy(null);
      }
    },
    [finishIfSignedIn, isAddMode, loginViaWebmail, step, t],
  );

  const handleEmailContinue = React.useCallback(async () => {
    const value = email.trim();
    if (!isEmailAddress(value)) {
      setNotice({
        title: t('login.mobile.notice_full_email', 'Enter a full email address'),
        detail: t('login.mobile.notice_full_email_detail', 'Like ada@example.com. If you sign in with a username instead, use “I know my server address”.'),
      });
      return;
    }

    setNotice(null);
    setSearching(true);
    rememberEmail(value);
    try {
      const found = await discoverServerForEmail(value, { knownServerUrls });
      if (found) {
        setServerUrl(found);
        setServerInput(found);
        setServerDiscovered(true);
        goTo('confirm');
      } else {
        setFailedDomain(emailDomain(value));
        setServerInput('');
        goTo('server');
      }
    } finally {
      setSearching(false);
    }
  }, [email, goTo, knownServerUrls, rememberEmail, t]);

  const handleServerContinue = React.useCallback(() => {
    const normalized = normalizeServerUrl(serverInput);
    if (!normalized) {
      setNotice({
        title: t('login.mobile.notice_bad_server', "That doesn't look like a server address"),
        detail: t('login.mobile.notice_bad_server_detail', 'Try the address you use for webmail, like mail.example.com.'),
      });
      return;
    }
    setServerUrl(normalized);
    setServerDiscovered(false);
    goTo('confirm');
  }, [goTo, serverInput, t]);

  const handlePasswordSubmit = React.useCallback(async () => {
    const target = serverUrl || normalizeServerUrl(serverInput);
    if (!target) {
      setNotice({ title: t('login.mobile.notice_need_server', 'We need a server address first') });
      return;
    }
    if (!email.trim() || !password) {
      setNotice({ title: t('login.mobile.notice_need_credentials', 'Enter your email and password') });
      return;
    }

    if (totpRequired && !/^\d{6,8}$/.test(totp.trim())) {
      setNotice({ title: t('login.mobile.notice_need_code', 'Enter the 6-digit code from your authenticator app') });
      return;
    }

    setNotice(null);
    setBusy('connecting');
    const wasAuthenticated = useAuthStore.getState().isAuthenticated;
    try {
      await login(target, email.trim(), password, {
        addAccount: isAddMode,
        totp: totpRequired ? totp.trim() : undefined,
      });
      finishIfSignedIn(wasAuthenticated);
    } catch (err) {
      if (err instanceof Error && err.name === 'TotpRequiredError') {
        setTotpRequired(true);
        setNotice(describeLoginError(err, { serverUrl: target, t }));
        return;
      }
      setNotice(describeLoginError(err, { serverUrl: target, t }));
    } finally {
      setBusy(null);
    }
  }, [email, finishIfSignedIn, isAddMode, login, password, serverInput, serverUrl, totp, totpRequired, t]);

  const handleScanned = React.useCallback(
    async (data: string) => {
      setScannerVisible(false);
      const payload = parseQrLoginPayload(data);
      if (!payload) {
        setNotice({
          title: t('login.mobile.notice_bad_qr', "That code isn't a Bulwark sign-in code"),
          detail: t('login.mobile.notice_bad_qr_detail', 'Open Bulwark on the web, then Settings → Security → Link Mobile App to show one.'),
        });
        return;
      }

      if (payload.kind === 'connect') {
        // Server-bootstrap code: it carries the address, the user still
        // authenticates in the webmail.
        setServerUrl(payload.webmailUrl);
        setServerInput(payload.webmailUrl);
        await runHandoff(payload.webmailUrl);
        return;
      }

      // Cross-device pairing code: redeem it for tokens, no browser needed.
      setNotice(null);
      setBusy('pairing');
      const wasAuthenticated = useAuthStore.getState().isAuthenticated;
      try {
        await loginViaPairing(payload.webmailUrl, payload.code, { addAccount: isAddMode });
        finishIfSignedIn(wasAuthenticated);
      } catch (err) {
        setNotice(describeLoginError(err, { serverUrl: payload.webmailUrl, t }));
      } finally {
        setBusy(null);
      }
    },
    [finishIfSignedIn, isAddMode, loginViaPairing, runHandoff, t],
  );

  // ── render ─────────────────────────────────────────────

  if (busy) {
    return (
      <SigningInStep
        phase={busy}
        serverUrl={serverUrl || knownServerUrl}
        email={email.trim() || null}
      />
    );
  }

  const canGoBack = history.length > 0;
  const shellProps = {
    onBack: canGoBack ? goBack : undefined,
    onClose: isAddMode && onCancel ? onCancel : undefined,
  };

  if (step === 'choose') {
    // A leftover store error ("Session expired") is the reason some people
    // land back here, so it belongs on this screen.
    // The store keeps the raw English message; show the translated copy.
    const chooseNotice = notice ?? (storeError ? describeLoginError(storeError, { t }) : null);
    return (
      <>
        <LoginShell {...shellProps} centered showFooter>
          <ChooseStep
            isAddMode={isAddMode}
            accounts={accounts}
            knownServerUrl={isAddMode ? knownServerUrl : null}
            notice={chooseNotice}
            onScan={() => setScannerVisible(true)}
            onUseEmail={() => goTo('email')}
            onUseKnownServer={() => {
              if (!knownServerUrl) return;
              setServerUrl(knownServerUrl);
              setServerInput(knownServerUrl);
              setServerDiscovered(false);
              goTo('confirm');
            }}
            onManualSetup={() => {
              setFailedDomain(null);
              goTo('server');
            }}
          />
        </LoginShell>
        <QrScanModal
          visible={scannerVisible}
          onClose={() => setScannerVisible(false)}
          onScanned={(data) => void handleScanned(data)}
        />
      </>
    );
  }

  return (
    <>
      <LoginShell {...shellProps}>
        {step === 'email' ? (
          <EmailStep
            isAddMode={isAddMode}
            value={email}
            onChange={(value) => {
              setNotice(null);
              setEmail(value);
            }}
            onSubmit={() => void handleEmailContinue()}
            onKnowServer={() => {
              setFailedDomain(null);
              goTo('server');
            }}
            isSearching={searching}
            notice={notice}
            suggestions={emailSuggestions}
          />
        ) : null}

        {step === 'server' ? (
          <ServerStep
            value={serverInput}
            onChange={(value) => {
              setNotice(null);
              setServerInput(value);
            }}
            onSubmit={handleServerContinue}
            onScan={() => setScannerVisible(true)}
            failedDomain={failedDomain}
            notice={notice}
          />
        ) : null}

        {step === 'confirm' ? (
          <ConfirmStep
            serverUrl={serverUrl}
            discovered={serverDiscovered}
            onContinue={() => void runHandoff(serverUrl)}
            onChangeServer={() => {
              setFailedDomain(null);
              goTo('server');
            }}
            onUsePassword={() => goTo('password')}
            notice={notice}
          />
        ) : null}

        {step === 'password' ? (
          <PasswordStep
            serverUrl={serverUrl}
            email={email}
            password={password}
            onChangeEmail={(value) => {
              setNotice(null);
              setEmail(value);
            }}
            onChangePassword={(value) => {
              setNotice(null);
              setPassword(value);
            }}
            totp={totp}
            totpRequired={totpRequired}
            onChangeTotp={(value) => {
              setNotice(null);
              setTotp(value.replace(/\s+/g, ''));
            }}
            onSubmit={() => void handlePasswordSubmit()}
            notice={notice}
          />
        ) : null}
      </LoginShell>

      <QrScanModal
        visible={scannerVisible}
        onClose={() => setScannerVisible(false)}
        onScanned={(data) => void handleScanned(data)}
      />
    </>
  );
}
