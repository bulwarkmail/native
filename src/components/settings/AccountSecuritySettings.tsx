import React, { useCallback, useEffect, useState } from 'react';
import { Alert, View, Text, StyleSheet, Pressable, Linking, ActivityIndicator } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import {
  Key, Smartphone, Lock, Eye, EyeOff, ShieldCheck, Monitor, Trash2,
  Plus, Shield, Terminal, Check, ExternalLink, Calendar, X,
} from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Input from '../Input';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { jmapClient } from '../../api/jmap-client';
import {
  clearClientCertAlias,
  getClientCertAlias,
  isClientCertSupported,
  pickClientCertAlias,
} from '../../lib/client-cert';
import {
  isStalwartSupported,
  fetchAuthInfo,
  fetchEncryptionType,
  fetchPrincipal,
  changePassword,
  updateDisplayName,
  enableTotp,
  disableTotp,
  createAppPassword,
  removeAppPassword,
  createApiKey,
  removeApiKey,
  type AppCredentialInfo,
  type AppCredentialInput,
  type AuthInfo,
  type EncryptionType,
} from '../../api/account-security';
import { generateTotpEnrolment, type TotpEnrolment } from '../../lib/totp';

// ── TLS client certificate (mobile-only) ──────────────────
// Picks an installed Android cert for mTLS handshakes. Independent of the
// Stalwart account features below, so it stays visible even on non-Stalwart
// servers.
function ClientCertSection() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [certAlias, setCertAlias] = useState<string | null>(null);
  const [certBusy, setCertBusy] = useState(false);

  useEffect(() => {
    void getClientCertAlias().then(setCertAlias);
  }, []);

  const onPickCert = async () => {
    if (certBusy) return;
    setCertBusy(true);
    try {
      const host = jmapClient.serverUrl ? new URL(jmapClient.serverUrl).hostname : null;
      const alias = await pickClientCertAlias(host);
      setCertAlias(alias);
    } catch (err) {
      Alert.alert('Pick failed', err instanceof Error ? err.message : String(err));
    } finally {
      setCertBusy(false);
    }
  };

  const onClearCert = () => {
    if (certBusy) return;
    Alert.alert(
      'Stop using client certificate?',
      'New requests will no longer present a certificate. The certificate stays installed in Android.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            setCertBusy(true);
            try {
              await clearClientCertAlias();
              setCertAlias(null);
            } finally {
              setCertBusy(false);
            }
          },
        },
      ],
    );
  };

  return (
    <SettingsSection
      title="TLS client certificate"
      description="Picks an installed Android certificate to authenticate to the server during the TLS handshake. Useful when the reverse proxy enforces mTLS."
    >
      <View style={styles.certRow}>
        <ShieldCheck size={18} color={certAlias ? c.success : c.mutedForeground} />
        <View style={{ flex: 1 }}>
          <Text style={styles.certStatus}>{certAlias ? `Active: ${certAlias}` : 'Not set'}</Text>
          <Text style={styles.certHint}>
            Install the certificate via Android Settings → Security → Encryption &amp; credentials, then pick it here.
          </Text>
        </View>
      </View>
      <View style={styles.rowGap}>
        <Button variant="outline" size="sm" disabled={certBusy} onPress={() => { void onPickCert(); }}>
          {certAlias ? 'Choose another' : 'Pick certificate'}
        </Button>
        {certAlias && (
          <Button variant="outline" size="sm" disabled={certBusy} onPress={onClearCert}>
            Clear
          </Button>
        )}
      </View>
    </SettingsSection>
  );
}

// ── Password change ───────────────────────────────────────
function PasswordChangeSection() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError(null);
    if (newPwd.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (newPwd !== confirmPwd) { setError('Passwords do not match.'); return; }
    setSaving(true);
    try {
      await changePassword(currentPwd, newPwd);
      setCurrentPwd(''); setNewPwd(''); setConfirmPwd('');
      Alert.alert('Password changed', 'Your account password was updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Password" description="Change the password for this account.">
      <View style={{ gap: spacing.md }}>
        <View style={styles.pwField}>
          <Text style={styles.pwLabel}>Current password</Text>
          <View style={styles.pwInputRow}>
            <Input value={currentPwd} onChangeText={setCurrentPwd} secureTextEntry={!showCurrent} autoCapitalize="none" containerStyle={{ flex: 1 }} />
            <Pressable style={styles.eyeBtn} onPress={() => setShowCurrent((v) => !v)}>
              {showCurrent ? <EyeOff size={16} color={c.mutedForeground} /> : <Eye size={16} color={c.mutedForeground} />}
            </Pressable>
          </View>
        </View>

        <View style={styles.pwField}>
          <Text style={styles.pwLabel}>New password</Text>
          <View style={styles.pwInputRow}>
            <Input value={newPwd} onChangeText={setNewPwd} secureTextEntry={!showNew} autoCapitalize="none" containerStyle={{ flex: 1 }} />
            <Pressable style={styles.eyeBtn} onPress={() => setShowNew((v) => !v)}>
              {showNew ? <EyeOff size={16} color={c.mutedForeground} /> : <Eye size={16} color={c.mutedForeground} />}
            </Pressable>
          </View>
        </View>

        <View style={styles.pwField}>
          <Text style={styles.pwLabel}>Confirm password</Text>
          <Input value={confirmPwd} onChangeText={setConfirmPwd} secureTextEntry={!showNew} autoCapitalize="none" />
        </View>

        {error && <Text style={styles.errorText}>{error}</Text>}

        <View style={{ alignItems: 'flex-end' }}>
          <Button
            size="sm"
            loading={saving}
            disabled={saving || !currentPwd || !newPwd || !confirmPwd}
            onPress={() => { void submit(); }}
            icon={<Key size={14} color={c.primaryForeground} />}
          >
            Change Password
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

// ── Display name ──────────────────────────────────────────
function DisplayNameSection({ initial, onSaved }: { initial: string; onSaved: (name: string) => void }) {
  const c = useColors();
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setName(initial); }, [initial]);

  const save = async () => {
    setSaving(true);
    try {
      await updateDisplayName(name);
      onSaved(name);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      Alert.alert('Update failed', err instanceof Error ? err.message : 'Failed to update display name.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingItem label="Display name" description="The name shown on this account.">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Input value={name} onChangeText={setName} placeholder="Display name" containerStyle={{ width: 150 }} />
        <Button size="sm" loading={saving} disabled={saving || name === initial} onPress={() => { void save(); }}>
          {saved ? <Check size={14} color={c.primaryForeground} /> : 'Save'}
        </Button>
      </View>
    </SettingItem>
  );
}

// ── Two-factor authentication ─────────────────────────────
function TotpSection({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setEnrolment(null); setDisableOpen(false);
    setPassword(''); setOtpCode(''); setError(null);
  };

  const handleToggle = (enable: boolean) => {
    setError(''); setPassword(''); setOtpCode('');
    if (enable) {
      setEnrolment(generateTotpEnrolment(jmapClient.username ?? 'account'));
      setDisableOpen(false);
    } else {
      setEnrolment(null);
      setDisableOpen(true);
    }
  };

  const confirmEnable = async () => {
    if (!enrolment) return;
    if (!password) { setError('Enter your current password.'); return; }
    if (!otpCode.trim()) { setError('Enter the 6-digit code from your app.'); return; }
    setSaving(true);
    try {
      await enableTotp(password, enrolment.url, otpCode.trim());
      reset();
      onChanged();
      Alert.alert('Two-factor enabled', 'You will be asked for a code at next sign-in.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable two-factor authentication.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDisable = async () => {
    if (!password) { setError('Enter your current password.'); return; }
    setSaving(true);
    try {
      await disableTotp(password);
      reset();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable two-factor authentication.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ gap: spacing.md }}>
      <View style={styles.headerRow}>
        <Shield size={16} color={c.mutedForeground} />
        <Text style={styles.headerTitle}>Two-Factor Authentication</Text>
      </View>

      <SettingItem label="Authenticator app" description="Require a one-time code at login." noBorder>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <ToggleSwitch checked={enabled || !!enrolment} onChange={handleToggle} disabled={saving} />
          <Text style={[styles.statusText, { color: enabled ? c.success : c.mutedForeground }]}>
            {enabled ? 'Active' : 'Inactive'}
          </Text>
        </View>
      </SettingItem>

      {enrolment && (
        <View style={styles.panel}>
          <Text style={styles.panelHint}>
            Add this secret to your authenticator app, then enter the 6-digit code to confirm.
          </Text>
          <Button
            variant="outline"
            size="sm"
            icon={<ExternalLink size={14} color={c.text} />}
            onPress={() => { void Linking.openURL(enrolment.url).catch(() => Alert.alert('No authenticator app', 'Could not open an authenticator app. Add the secret below manually.')); }}
          >
            Add to authenticator app
          </Button>
          <View>
            <Text style={styles.pwLabel}>Or enter this secret manually</Text>
            <Text selectable style={styles.secretText}>{enrolment.secretFormatted}</Text>
          </View>
          <View>
            <Text style={styles.pwLabel}>Current password</Text>
            <Input value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" />
          </View>
          <View>
            <Text style={styles.pwLabel}>Verification code</Text>
            <Input value={otpCode} onChangeText={setOtpCode} keyboardType="number-pad" maxLength={6} />
          </View>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.rowGap}>
            <Button size="sm" loading={saving} disabled={saving || !password || !otpCode} onPress={() => { void confirmEnable(); }}>
              Confirm
            </Button>
            <Button variant="ghost" size="sm" onPress={reset}>Cancel</Button>
          </View>
        </View>
      )}

      {disableOpen && (
        <View style={styles.panel}>
          <Text style={styles.panelHint}>Enter your password to turn off two-factor authentication.</Text>
          <Input value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" placeholder="Current password" />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.rowGap}>
            <Button variant="destructive" size="sm" loading={saving} disabled={saving || !password} onPress={() => { void confirmDisable(); }}>
              Disable
            </Button>
            <Button variant="ghost" size="sm" onPress={reset}>Cancel</Button>
          </View>
        </View>
      )}
    </View>
  );
}

// ── App passwords / API keys ──────────────────────────────
function parseIpList(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

interface CredentialSectionProps {
  icon: typeof Smartphone;
  title: string;
  description: string;
  nameLabel: string;
  namePlaceholder: string;
  entries: AppCredentialInfo[];
  onCreate: (input: AppCredentialInput) => Promise<{ id: string; secret: string }>;
  onRemove: (id: string) => Promise<void>;
}

function CredentialSection({ icon: Icon, title, description, nameLabel, namePlaceholder, entries, onCreate, onRemove }: CredentialSectionProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<Date | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [allowedIpsRaw, setAllowedIpsRaw] = useState('');
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const resetForm = () => { setName(''); setExpiry(null); setAllowedIpsRaw(''); };

  const handleAdd = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const result = await onCreate({
        description: name.trim(),
        expiresAt: expiry ? expiry.toISOString() : null,
        allowedIps: parseIpList(allowedIpsRaw),
      });
      setCreatedSecret(result.secret);
      resetForm();
      setShowAdd(false);
    } catch (err) {
      Alert.alert('Could not create', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = (id: string) => {
    Alert.alert('Remove credential?', 'Any client using it will stop working.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await onRemove(id);
          } catch (err) {
            Alert.alert('Could not remove', err instanceof Error ? err.message : undefined);
          }
        },
      },
    ]);
  };

  const onPickDate = (_e: DateTimePickerEvent, date?: Date) => {
    setShowPicker(false);
    if (date) setExpiry(date);
  };

  return (
    <View style={{ gap: spacing.md }}>
      <View style={styles.headerRowBetween}>
        <View style={styles.headerRow}>
          <Icon size={16} color={c.mutedForeground} />
          <Text style={styles.headerTitle}>{title}</Text>
        </View>
        <Button variant="outline" size="sm" icon={<Plus size={14} color={c.text} />} onPress={() => setShowAdd((v) => !v)}>
          Add
        </Button>
      </View>
      <Text style={styles.panelHint}>{description}</Text>

      {createdSecret && (
        <View style={styles.panel}>
          <Text style={styles.panelHint}>Copy this now — it is shown only once. Tap and hold to select.</Text>
          <Text selectable style={styles.secretText}>{createdSecret}</Text>
          <View style={{ alignItems: 'flex-start' }}>
            <Button variant="ghost" size="sm" onPress={() => setCreatedSecret(null)}>Done</Button>
          </View>
        </View>
      )}

      {showAdd && (
        <View style={styles.panel}>
          <View>
            <Text style={styles.pwLabel}>{nameLabel}</Text>
            <Input value={name} onChangeText={setName} placeholder={namePlaceholder} />
          </View>
          <View>
            <Text style={styles.pwLabel}>Expires (optional)</Text>
            <View style={styles.rowGap}>
              <Button variant="outline" size="sm" icon={<Calendar size={14} color={c.text} />} onPress={() => setShowPicker(true)}>
                {expiry ? expiry.toLocaleDateString() : 'No expiry'}
              </Button>
              {expiry && (
                <Pressable style={styles.clearExpiry} onPress={() => setExpiry(null)}>
                  <X size={14} color={c.mutedForeground} />
                </Pressable>
              )}
            </View>
            {showPicker && (
              <DateTimePicker value={expiry ?? new Date()} mode="date" minimumDate={new Date()} onChange={onPickDate} />
            )}
          </View>
          <View>
            <Text style={styles.pwLabel}>Allowed IPs (optional)</Text>
            <Input value={allowedIpsRaw} onChangeText={setAllowedIpsRaw} placeholder="1.2.3.4, 10.0.0.0/8" autoCapitalize="none" />
            <Text style={styles.fieldHint}>Comma or space separated. Leave empty to allow any IP.</Text>
          </View>
          <View style={styles.rowGap}>
            <Button size="sm" loading={saving} disabled={saving || !name.trim()} onPress={() => { void handleAdd(); }}>Create</Button>
            <Button variant="ghost" size="sm" onPress={() => { setShowAdd(false); resetForm(); }}>Cancel</Button>
          </View>
        </View>
      )}

      {entries.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          {entries.map((entry) => (
            <View key={entry.id} style={styles.credRow}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.credName} numberOfLines={1}>{entry.description || entry.id}</Text>
                {entry.createdAt && (
                  <Text style={styles.credMeta}>
                    {new Date(entry.createdAt).toLocaleDateString()}
                    {entry.expiresAt ? ` · expires ${new Date(entry.expiresAt).toLocaleDateString()}` : ''}
                  </Text>
                )}
                {entry.allowedIps.length > 0 && (
                  <View style={styles.ipWrap}>
                    {entry.allowedIps.map((ip) => (
                      <View key={ip} style={styles.ipPill}><Text style={styles.ipText}>{ip}</Text></View>
                    ))}
                  </View>
                )}
              </View>
              <Pressable style={styles.iconBtn} onPress={() => handleRemove(entry.id)}>
                <Trash2 size={16} color={c.error} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.emptyText}>None yet.</Text>
      )}
    </View>
  );
}

// ── Email client (OAuth accounts) ─────────────────────────
function EmailClientSection() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const username = jmapClient.username ?? '';

  return (
    <View style={{ gap: spacing.md }}>
      <View style={styles.headerRow}>
        <Monitor size={16} color={c.mutedForeground} />
        <Text style={styles.headerTitle}>Email client setup</Text>
      </View>
      <Text style={styles.panelHint}>
        To configure another mail client, use the username below and an app password (create one above) as the password.
      </Text>
      <View style={styles.panel}>
        <Text style={styles.pwLabel}>JMAP / IMAP username</Text>
        <Text selectable style={styles.secretText}>{username}</Text>
      </View>
    </View>
  );
}

// ── Encryption at rest (read-only status) ─────────────────
function EncryptionSection({ type }: { type: EncryptionType }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const enabled = type !== 'Disabled';
  return (
    <View style={{ gap: spacing.md }}>
      <View style={styles.headerRow}>
        <Lock size={16} color={c.mutedForeground} />
        <Text style={styles.headerTitle}>Encryption at rest</Text>
      </View>
      <SettingItem label="Stored message encryption" description="Server-side encryption of stored messages." noBorder>
        <Text style={[styles.statusText, { color: enabled ? c.success : c.mutedForeground }]}>
          {enabled ? `Active (${type})` : 'Disabled'}
        </Text>
      </SettingItem>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────
export function AccountSecuritySettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const certSupported = isClientCertSupported();
  const isOAuth = jmapClient.usesBearerAuth;

  // null = still probing; false = server lacks the Stalwart extension.
  const [supported, setSupported] = useState<boolean | null>(null);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [encryption, setEncryption] = useState<EncryptionType>('Disabled');
  const [loadError, setLoadError] = useState<string | null>(null);

  const reloadAuth = useCallback(async () => {
    try {
      setAuth(await fetchAuthInfo());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load security settings.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const session = jmapClient.currentSession;
    if (!session) { setSupported(false); return; }
    if (!isStalwartSupported()) { setSupported(false); return; }
    setSupported(true);

    (async () => {
      try {
        const authInfo = await fetchAuthInfo();
        if (cancelled) return;
        setAuth(authInfo);
        if (!isOAuth) {
          // Principal + crypto only matter for password accounts; failures are
          // non-fatal (e.g. a non-admin principal read is forbidden).
          const [principal, enc] = await Promise.allSettled([fetchPrincipal(), fetchEncryptionType()]);
          if (cancelled) return;
          if (principal.status === 'fulfilled') setDisplayName(principal.value.displayName);
          if (enc.status === 'fulfilled') setEncryption(enc.value);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load security settings.');
      }
    })();

    return () => { cancelled = true; };
  }, [isOAuth]);

  return (
    <View style={styles.container}>
      {certSupported && <ClientCertSection />}

      {supported === null && (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={c.mutedForeground} />
          <Text style={styles.panelHint}>Detecting server features…</Text>
        </View>
      )}

      {supported === false && (
        <SettingsSection title="Account security" description="Manage your password, two-factor authentication, and app credentials.">
          <Text style={styles.emptyText}>
            Account security management requires a Stalwart server. These features are not available for this account.
          </Text>
        </SettingsSection>
      )}

      {supported && (
        <SettingsSection title="Account security" description="Manage your password, two-factor authentication, and app credentials.">
          <View style={{ gap: spacing.xxxl }}>
            {loadError ? <Text style={styles.errorText}>{loadError}</Text> : null}

            {!isOAuth && (
              <>
                <PasswordChangeSection />
                <DisplayNameSection initial={displayName} onSaved={setDisplayName} />
                <TotpSection enabled={!!auth?.otpEnabled} onChanged={() => { void reloadAuth(); }} />
              </>
            )}

            <CredentialSection
              icon={Smartphone}
              title="App passwords"
              description="Generate passwords for other mail clients that can't do interactive login."
              nameLabel="Name"
              namePlaceholder="e.g. Thunderbird laptop"
              entries={auth?.appPasswords ?? []}
              onCreate={async (input) => { const r = await createAppPassword(input); await reloadAuth(); return r; }}
              onRemove={async (id) => { await removeAppPassword(id); await reloadAuth(); }}
            />

            <CredentialSection
              icon={Terminal}
              title="API keys"
              description="Tokens for scripts and integrations that use the JMAP API."
              nameLabel="Name"
              namePlaceholder="e.g. Backup script"
              entries={auth?.apiKeys ?? []}
              onCreate={async (input) => { const r = await createApiKey(input); await reloadAuth(); return r; }}
              onRemove={async (id) => { await removeApiKey(id); await reloadAuth(); }}
            />

            {isOAuth && <EmailClientSection />}
            {!isOAuth && <EncryptionSection type={encryption} />}
          </View>
        </SettingsSection>
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { gap: spacing.xxxl },
    rowGap: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', alignItems: 'center' },
    loadingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },

    headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    headerRowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    headerTitle: { ...typography.bodyMedium, color: c.text },

    statusText: { ...typography.caption, fontWeight: '500' },

    pwField: { gap: 4 },
    pwLabel: { ...typography.caption, color: c.mutedForeground, marginBottom: 4 },
    pwInputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    eyeBtn: { padding: spacing.sm },
    fieldHint: { ...typography.caption, color: c.mutedForeground, marginTop: 4, fontSize: 11 },
    errorText: { ...typography.caption, color: c.error },

    panel: {
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: c.muted,
    },
    panelHint: { ...typography.caption, color: c.mutedForeground },
    secretText: {
      ...typography.body,
      fontFamily: 'monospace',
      color: c.text,
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    clearExpiry: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },

    credRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
    },
    credName: { ...typography.bodyMedium, color: c.text },
    credMeta: { ...typography.caption, color: c.mutedForeground, marginTop: 2 },
    ipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
    ipPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.xs, backgroundColor: c.background, borderWidth: 1, borderColor: c.border },
    ipText: { fontSize: 10, fontFamily: 'monospace', color: c.mutedForeground },
    iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
    emptyText: { ...typography.caption, color: c.mutedForeground, fontStyle: 'italic' },

    // TLS client cert
    certRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.md },
    certStatus: { ...typography.bodyMedium, color: c.text },
    certHint: { ...typography.caption, color: c.mutedForeground, marginTop: 4 },
  });
}
