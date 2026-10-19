import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ClipboardPaste, Globe, QrCode, ShieldCheck, X } from '../../components/icons';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { Button, Input } from '../../components';
import LoginNotice from './LoginNotice';
import { useLocaleStore } from '../../stores/locale-store';

interface ServerStepProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onScan: () => void;
  onPaste: () => void;
  /** Set when we got here because discovery came back empty for this domain. */
  failedDomain?: string | null;
  notice?: { title: string; detail?: string } | null;
  /**
   * TLS client certificate for a reverse proxy that asks for one (#3).
   * Undefined where the platform has no certificate store to pick from.
   */
  clientCert?: {
    alias: string | null;
    busy: boolean;
    onPick: () => void;
    onClear: () => void;
  };
}

/**
 * Asks for the address people actually know — the one they type in the browser
 * to reach their webmail — not the JMAP session endpoint. The scheme and the
 * `/.well-known/jmap` suffix are our problem, not theirs.
 */
export default function ServerStep({
  value,
  onChange,
  onSubmit,
  onScan,
  onPaste,
  failedDomain,
  notice,
  clientCert,
}: ServerStepProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  return (
    <View style={styles.root}>
      <View style={styles.heading}>
        <Text style={styles.title}>{t('login.mobile.server_title', "What's your server address?")}</Text>
        <Text style={styles.subtitle}>
          {failedDomain
            ? t('login.mobile.server_not_found', "We couldn't find a server for {domain}. If you self-host, the address is the one you use for webmail.", { domain: failedDomain })
            : t('login.mobile.server_subtitle', 'Enter the address you use to reach your webmail.')}
        </Text>
      </View>

      <Input
        label={t('login.mobile.server_label', 'Server address')}
        placeholder="mail.example.com"
        value={value}
        onChangeText={onChange}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={onSubmit}
        leftIcon={<Globe size={17} color={c.textMuted} />}
      />

      <Text style={styles.hint}>{t('login.mobile.server_hint', "Same address you type in the browser. We'll add https:// for you.")}</Text>

      {notice ? <LoginNotice title={notice.title} detail={notice.detail} /> : null}

      <Button variant="default" size="md" onPress={onSubmit}>
        {t('login.mobile.continue', 'Continue')}
      </Button>

      <View>
        <Pressable onPress={onScan} hitSlop={8} style={styles.scanRow} accessibilityRole="button">
          <QrCode size={15} color={c.textMuted} />
          <Text style={styles.scanText}>
            {t('login.mobile.server_scan_hint', "If you're not sure, scan a sign-in code instead. It carries the server address.")}
          </Text>
        </Pressable>
        <Pressable onPress={onPaste} hitSlop={8} style={styles.scanRow} accessibilityRole="button">
          <ClipboardPaste size={15} color={c.textMuted} />
          <Text style={styles.scanText}>
            {t('login.mobile.server_paste_hint', 'Have a sign-in link instead? Paste it here.')}
          </Text>
        </Pressable>
        {clientCert ? (
          <Pressable
            onPress={clientCert.onPick}
            disabled={clientCert.busy}
            hitSlop={8}
            style={styles.scanRow}
            accessibilityRole="button"
            testID="login-client-cert"
          >
            <ShieldCheck size={15} color={clientCert.alias ? c.success : c.textMuted} />
            <Text style={styles.scanText}>
              {clientCert.alias
                ? t('login.mobile.server_cert_active', 'Signing in with the client certificate "{alias}". Tap to choose another.', { alias: clientCert.alias })
                : t('login.mobile.server_cert_hint', 'Does your server ask for a client certificate? Pick one installed on this phone.')}
            </Text>
          </Pressable>
        ) : null}
        {clientCert?.alias ? (
          <Pressable
            onPress={clientCert.onClear}
            disabled={clientCert.busy}
            hitSlop={8}
            style={styles.scanRow}
            accessibilityRole="button"
            testID="login-client-cert-clear"
          >
            <X size={15} color={c.textMuted} />
            <Text style={styles.scanText}>
              {t('login.mobile.server_cert_clear', 'Sign in without the certificate')}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    root: { gap: spacing.lg },
    heading: { gap: spacing.sm },
    title: { ...typography.h1, color: c.text },
    subtitle: { ...typography.body, color: c.textSecondary },
    hint: { ...typography.caption, color: c.textMuted, marginTop: -spacing.sm },
    scanRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.sm },
    scanText: { ...typography.caption, color: c.textMuted, flex: 1, lineHeight: 17 },
  });
}
