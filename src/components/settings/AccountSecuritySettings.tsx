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
import { useAuthStore } from '../../stores/auth-store';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import { supportsRecentsHiding, supportsScreenPrivacy } from '../../lib/screen-privacy';
import {
  isStalwartSupported,
  fetchAuthInfo,
  fetchCryptoInfo,
  fetchPrincipal,
  fetchAccountDisplayName,
  fetchPublicKeys,
  createPublicKey,
  removePublicKey,
  updateEncryptionAtRest,
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
  type CryptoInfo,
  type EncryptionType,
  type PublicKeyInfo,
} from '../../api/account-security';
import { generateTotpEnrolment, type TotpEnrolment } from '../../lib/totp';

// ── TLS client certificate (mobile-only) ──────────────────
// Picks an installed Android cert for mTLS handshakes. Independent of the
// Stalwart account features below, so it stays visible even on non-Stalwart
// servers.
function ClientCertSection() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
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
      Alert.alert(t('settings.security.client_cert.pick_failed', "Pick failed"), err instanceof Error ? err.message : String(err));
    } finally {
      setCertBusy(false);
    }
  };

  const onClearCert = () => {
    if (certBusy) return;
    Alert.alert(
      t('settings.security.client_cert.clear_title', "Stop using client certificate?"),
      t('settings.security.client_cert.clear_message', "New requests will no longer present a certificate. The certificate stays installed in Android."),
      [
        { text: t('common.cancel', "Cancel"), style: 'cancel' },
        {
          text: t('settings.security.client_cert.clear', "Clear"),
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
      title={t('settings.security.client_cert.title', "TLS client certificate")}
      description={t('settings.security.client_cert.description', "Picks an installed Android certificate to authenticate to the server during the TLS handshake. Useful when the reverse proxy enforces mTLS.")}
    >
      <View style={styles.certRow}>
        <ShieldCheck size={18} color={certAlias ? c.success : c.mutedForeground} />
        <View style={{ flex: 1 }}>
          <Text style={styles.certStatus}>
            {certAlias
              ? t('settings.security.client_cert.active', 'Active: {alias}', { alias: certAlias })
              : t('settings.security.client_cert.not_set', "Not set")}
          </Text>
          <Text style={styles.certHint}>
            {t('settings.security.client_cert.hint', "Install the certificate via Android Settings → Security → Encryption & credentials, then pick it here.")}
          </Text>
        </View>
      </View>
      <View style={styles.rowGap}>
        <Button variant="outline" size="sm" disabled={certBusy} onPress={() => { void onPickCert(); }}>
          {certAlias ? t('settings.security.client_cert.choose_another', "Choose another") : t('settings.security.client_cert.pick', "Pick certificate")}
        </Button>
        {certAlias && (
          <Button variant="outline" size="sm" disabled={certBusy} onPress={onClearCert}>
            {t('settings.security.client_cert.clear', "Clear")}
          </Button>
        )}
      </View>
    </SettingsSection>
  );
}

// ── Password change ───────────────────────────────────────
function PasswordChangeSection({ otpEnabled }: { otpEnabled: boolean }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwOtpCode, setPwOtpCode] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError(null);
    if (newPwd.length < 8) { setError(t('settings.security.password.too_short', "New password must be at least 8 characters.")); return; }
    if (newPwd !== confirmPwd) { setError(t('settings.security.password.mismatch', "Passwords do not match.")); return; }
    setSaving(true);
    try {
      await changePassword(currentPwd, newPwd, otpEnabled ? pwOtpCode : undefined);
      setCurrentPwd(''); setNewPwd(''); setConfirmPwd(''); setPwOtpCode('');
      Alert.alert(t('settings.security.password.changed_title', "Password changed"), t('settings.security.password.changed', "Your account password was updated."));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.security.password.error', "Failed to change password."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title={t('settings.security.password.title', "Password")} description={t('settings.security.password.description', "Change the password for this account.")}>
      <View style={{ gap: spacing.md }}>
        <View style={styles.pwField}>
          <Text style={styles.pwLabel}>{t('settings.security.password.current', "Current password")}</Text>
          <View style={styles.pwInputRow}>
            <Input value={currentPwd} onChangeText={setCurrentPwd} secureTextEntry={!showCurrent} autoCapitalize="none" containerStyle={{ flex: 1 }} />
            <Pressable style={styles.eyeBtn} onPress={() => setShowCurrent((v) => !v)} accessibilityRole="button" accessibilityLabel={t('settings.security.password.toggle_visibility', "Show or hide password")}>
              {showCurrent ? <EyeOff size={16} color={c.mutedForeground} /> : <Eye size={16} color={c.mutedForeground} />}
            </Pressable>
          </View>
        </View>

        <View style={styles.pwField}>
          <Text style={styles.pwLabel}>{t('settings.security.password.new', "New password")}</Text>
          <View style={styles.pwInputRow}>
            <Input value={newPwd} onChangeText={setNewPwd} secureTextEntry={!showNew} autoCapitalize="none" containerStyle={{ flex: 1 }} />
            <Pressable style={styles.eyeBtn} onPress={() => setShowNew((v) => !v)} accessibilityRole="button" accessibilityLabel={t('settings.security.password.toggle_visibility', "Show or hide password")}>
              {showNew ? <EyeOff size={16} color={c.mutedForeground} /> : <Eye size={16} color={c.mutedForeground} />}
            </Pressable>
          </View>
        </View>

        <View style={styles.pwField}>
          <Text style={styles.pwLabel}>{t('settings.security.password.confirm', "Confirm password")}</Text>
          <Input value={confirmPwd} onChangeText={setConfirmPwd} secureTextEntry={!showNew} autoCapitalize="none" />
        </View>

        {otpEnabled && (
          <View style={styles.pwField}>
            <Text style={styles.pwLabel}>{t('settings.security.two_factor.code', "Verification code")}</Text>
            <Input value={pwOtpCode} onChangeText={setPwOtpCode} keyboardType="number-pad" maxLength={6} />
          </View>
        )}

        {error && <Text style={styles.errorText}>{error}</Text>}

        <View style={{ alignItems: 'flex-end' }}>
          <Button
            size="sm"
            loading={saving}
            disabled={saving || !currentPwd || !newPwd || !confirmPwd || (otpEnabled && !pwOtpCode.trim())}
            onPress={() => { void submit(); }}
            icon={<Key size={14} color={c.primaryForeground} />}
          >
            {t('settings.security.password.change', "Change Password")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

// ── Display name ──────────────────────────────────────────
function DisplayNameSection({ initial, onSaved }: { initial: string; onSaved: (name: string) => void }) {
  const c = useColors();
  const t = useLocaleStore((s) => s.t);
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
      Alert.alert(t('settings.security.display_name.error_title', "Update failed"), err instanceof Error ? err.message : t('settings.security.display_name.error', "Failed to update display name."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingItem label={t('settings.security.display_name.label', "Display name")} description={t('settings.security.display_name.description', "The name shown on this account.")}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Input value={name} onChangeText={setName} placeholder={t('settings.security.display_name.label', "Display name")} containerStyle={{ width: 150 }} />
        <Button size="sm" loading={saving} disabled={saving || name === initial} onPress={() => { void save(); }}>
          {saved ? <Check size={14} color={c.primaryForeground} /> : t('common.save', "Save")}
        </Button>
      </View>
    </SettingItem>
  );
}

// ── Two-factor authentication ─────────────────────────────
function TotpSection({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
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
    if (!password) { setError(t('settings.security.two_factor.password_required', "Enter your current password.")); return; }
    if (!otpCode.trim()) { setError(t('settings.security.two_factor.code_required', "Enter the 6-digit code from your app.")); return; }
    setSaving(true);
    try {
      await enableTotp(password, enrolment.url, otpCode.trim());
      reset();
      onChanged();
      Alert.alert(t('settings.security.two_factor.enabled_title', "Two-factor enabled"), t('settings.security.two_factor.enabled_message', "You will be asked for a code at next sign-in."));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.security.two_factor.enable_error', "Failed to enable two-factor authentication."));
    } finally {
      setSaving(false);
    }
  };

  const confirmDisable = async () => {
    if (!password) { setError(t('settings.security.two_factor.password_required', "Enter your current password.")); return; }
    setSaving(true);
    try {
      await disableTotp(password, otpCode);
      reset();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.security.two_factor.disable_error', "Failed to disable two-factor authentication."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ gap: spacing.md }}>
      <View style={styles.headerRow}>
        <Shield size={16} color={c.mutedForeground} />
        <Text style={styles.headerTitle}>{t('settings.security.two_factor.section_title', "Two-Factor Authentication")}</Text>
      </View>

      <SettingItem label={t('settings.security.two_factor.label', "Authenticator app")} description={t('settings.security.two_factor.description', "Require a one-time code at login.")} noBorder>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <ToggleSwitch checked={enabled || !!enrolment} onChange={handleToggle} disabled={saving} />
          <Text style={[styles.statusText, { color: enabled ? c.success : c.mutedForeground }]}>
            {enabled ? t('settings.security.two_factor.active', "Active") : t('settings.security.two_factor.inactive', "Inactive")}
          </Text>
        </View>
      </SettingItem>

      {enrolment && (
        <View style={styles.panel}>
          <Text style={styles.panelHint}>
            {t('settings.security.two_factor.enrol_hint', "Add this secret to your authenticator app, then enter the 6-digit code to confirm.")}
          </Text>
          <Button
            variant="outline"
            size="sm"
            icon={<ExternalLink size={14} color={c.text} />}
            onPress={() => { void Linking.openURL(enrolment.url).catch(() => Alert.alert(t('settings.security.two_factor.no_app_title', "No authenticator app"), t('settings.security.two_factor.no_app', "Could not open an authenticator app. Add the secret below manually."))); }}
          >
            {t('settings.security.two_factor.open_app', "Add to authenticator app")}
          </Button>
          <View>
            <Text style={styles.pwLabel}>{t('settings.security.two_factor.manual_secret', "Or enter this secret manually")}</Text>
            <Text selectable style={styles.secretText}>{enrolment.secretFormatted}</Text>
          </View>
          <View>
            <Text style={styles.pwLabel}>{t('settings.security.password.current', "Current password")}</Text>
            <Input value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" />
          </View>
          <View>
            <Text style={styles.pwLabel}>{t('settings.security.two_factor.code', "Verification code")}</Text>
            <Input value={otpCode} onChangeText={setOtpCode} keyboardType="number-pad" maxLength={6} />
          </View>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.rowGap}>
            <Button size="sm" loading={saving} disabled={saving || !password || !otpCode} onPress={() => { void confirmEnable(); }}>
              {t('common.confirm', "Confirm")}
            </Button>
            <Button variant="ghost" size="sm" onPress={reset}>{t('common.cancel', "Cancel")}</Button>
          </View>
        </View>
      )}

      {disableOpen && (
        <View style={styles.panel}>
          <Text style={styles.panelHint}>{t('settings.security.two_factor.disable_hint', "Enter your password to turn off two-factor authentication.")}</Text>
          <Input value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" placeholder={t('settings.security.password.current', "Current password")} />
          <View>
            <Text style={styles.pwLabel}>{t('settings.security.two_factor.code', "Verification code")}</Text>
            <Input value={otpCode} onChangeText={setOtpCode} keyboardType="number-pad" maxLength={6} />
          </View>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.rowGap}>
            <Button variant="destructive" size="sm" loading={saving} disabled={saving || !password || !otpCode.trim()} onPress={() => { void confirmDisable(); }}>
              {t('settings.security.two_factor.disable', "Disable")}
            </Button>
            <Button variant="ghost" size="sm" onPress={reset}>{t('common.cancel', "Cancel")}</Button>
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
  const t = useLocaleStore((s) => s.t);
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
      Alert.alert(t('settings.security.credentials.create_error', "Could not create"), err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = (id: string) => {
    Alert.alert(t('settings.security.credentials.remove_title', "Remove credential?"), t('settings.security.credentials.remove_message', "Any client using it will stop working."), [
      { text: t('common.cancel', "Cancel"), style: 'cancel' },
      {
        text: t('common.remove', "Remove"),
        style: 'destructive',
        onPress: async () => {
          try {
            await onRemove(id);
          } catch (err) {
            Alert.alert(t('settings.security.credentials.remove_error', "Could not remove"), err instanceof Error ? err.message : undefined);
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
          {t('common.add', "Add")}
        </Button>
      </View>
      <Text style={styles.panelHint}>{description}</Text>

      {createdSecret && (
        <View style={styles.panel}>
          <Text style={styles.panelHint}>{t('settings.security.credentials.copy_now', "Copy this now — it is shown only once. Tap and hold to select.")}</Text>
          <Text selectable style={styles.secretText}>{createdSecret}</Text>
          <View style={{ alignItems: 'flex-start' }}>
            <Button variant="ghost" size="sm" onPress={() => setCreatedSecret(null)}>{t('common.done', "Done")}</Button>
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
            <Text style={styles.pwLabel}>{t('settings.security.credentials.expires', "Expires (optional)")}</Text>
            <View style={styles.rowGap}>
              <Button variant="outline" size="sm" icon={<Calendar size={14} color={c.text} />} onPress={() => setShowPicker(true)}>
                {expiry ? expiry.toLocaleDateString() : t('settings.security.credentials.no_expiry', "No expiry")}
              </Button>
              {expiry && (
                <Pressable style={styles.clearExpiry} onPress={() => setExpiry(null)} accessibilityRole="button" accessibilityLabel={t('settings.security.credentials.clear_expiry', "Clear expiry")}>
                  <X size={14} color={c.mutedForeground} />
                </Pressable>
              )}
            </View>
            {showPicker && (
              <DateTimePicker value={expiry ?? new Date()} mode="date" minimumDate={new Date()} onChange={onPickDate} />
            )}
          </View>
          <View>
            <Text style={styles.pwLabel}>{t('settings.security.credentials.allowed_ips', "Allowed IPs (optional)")}</Text>
            <Input value={allowedIpsRaw} onChangeText={setAllowedIpsRaw} placeholder="1.2.3.4, 10.0.0.0/8" autoCapitalize="none" />
            <Text style={styles.fieldHint}>{t('settings.security.credentials.allowed_ips_hint', "Comma or space separated. Leave empty to allow any IP.")}</Text>
          </View>
          <View style={styles.rowGap}>
            <Button size="sm" loading={saving} disabled={saving || !name.trim()} onPress={() => { void handleAdd(); }}>{t('common.create', "Create")}</Button>
            <Button variant="ghost" size="sm" onPress={() => { setShowAdd(false); resetForm(); }}>{t('common.cancel', "Cancel")}</Button>
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
                    {entry.expiresAt ? ` · ${t('settings.security.credentials.expires_on', 'expires {date}', { date: new Date(entry.expiresAt).toLocaleDateString() })}` : ''}
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
              <Pressable style={styles.iconBtn} onPress={() => handleRemove(entry.id)} accessibilityRole="button" accessibilityLabel={t('common.remove', "Remove")}>
                <Trash2 size={16} color={c.error} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.emptyText}>{t('settings.security.credentials.none', "None yet.")}</Text>
      )}
    </View>
  );
}

// ── Email client (OAuth accounts) ─────────────────────────
function EmailClientSection() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const username = jmapClient.username ?? '';

  return (
    <View style={{ gap: spacing.md }}>
      <View style={styles.headerRow}>
        <Monitor size={16} color={c.mutedForeground} />
        <Text style={styles.headerTitle}>{t('settings.security.email_client.title', "Email Client Setup")}</Text>
      </View>
      <Text style={styles.panelHint}>
        {t('settings.security.email_client.password_instructions', "Use your JMAP username above along with an app password to sign in to your email client. Create an app password in the section above if you haven't already.")}
      </Text>
      <View style={styles.panel}>
        <Text style={styles.pwLabel}>{t('settings.security.email_client.jmap_username_label', "JMAP Username")}</Text>
        <Text selectable style={styles.secretText}>{username}</Text>
      </View>
    </View>
  );
}

// ── Public keys (S/MIME / PGP) ────────────────────────────
function PublicKeysSection({
  keys,
  onChanged,
}: {
  keys: PublicKeyInfo[];
  onChanged: () => Promise<void>;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [keyText, setKeyText] = useState('');
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim() || !keyText.trim()) return;
    setSaving(true);
    try {
      await createPublicKey({ description: name.trim(), key: keyText.trim() });
      setName(''); setKeyText(''); setShowAdd(false);
      await onChanged();
    } catch (err) {
      Alert.alert(
        t('settings.security.public_keys.add_error', 'Failed to add public key'),
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = (key: PublicKeyInfo) => {
    Alert.alert(
      t('settings.security.public_keys.remove_title', 'Remove public key?'),
      t('settings.security.public_keys.remove_message', 'Encryption at rest that uses this key will stop working.'),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: t('common.remove', 'Remove'),
          style: 'destructive',
          onPress: async () => {
            setRemovingId(key.id);
            try {
              await removePublicKey(key.id);
              await onChanged();
            } catch (err) {
              Alert.alert(
                t('settings.security.public_keys.remove_error', 'Failed to remove public key'),
                err instanceof Error ? err.message : undefined,
              );
            } finally {
              setRemovingId(null);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={{ gap: spacing.md }}>
      <View style={styles.headerRowBetween}>
        <View style={styles.headerRow}>
          <Key size={16} color={c.mutedForeground} />
          <Text style={styles.headerTitle}>{t('settings.security.public_keys.title', 'Public Keys')}</Text>
        </View>
        <Button variant="outline" size="sm" icon={<Plus size={14} color={c.text} />} onPress={() => setShowAdd((v) => !v)}>
          {t('common.add', 'Add')}
        </Button>
      </View>
      <Text style={styles.panelHint}>
        {t('settings.security.public_keys.description', 'S/MIME certificates and PGP keys stored on the server. They are used for encryption at rest.')}
      </Text>

      {showAdd && (
        <View style={styles.panel}>
          <View>
            <Text style={styles.pwLabel}>{t('settings.security.public_keys.name_label', 'Public Key name')}</Text>
            <Input value={name} onChangeText={setName} placeholder={t('settings.security.public_keys.name_placeholder', 'e.g. My Key')} />
          </View>
          <View>
            <Text style={styles.pwLabel}>{t('settings.security.public_keys.key_label', 'Public Key (S/MIME or PGP ASCII-armored)')}</Text>
            <Input
              value={keyText}
              onChangeText={setKeyText}
              placeholder={t('settings.security.public_keys.key_placeholder', 'Paste your public key here')}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              style={{ minHeight: 120, textAlignVertical: 'top', fontFamily: 'monospace' }}
            />
          </View>
          <View style={styles.rowGap}>
            <Button size="sm" loading={saving} disabled={saving || !name.trim() || !keyText.trim()} onPress={() => { void add(); }}>
              {t('common.add', 'Add')}
            </Button>
            <Button variant="ghost" size="sm" onPress={() => { setShowAdd(false); setName(''); setKeyText(''); }}>
              {t('common.cancel', 'Cancel')}
            </Button>
          </View>
        </View>
      )}

      {keys.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          {keys.map((key) => (
            <View key={key.id} style={styles.credRow}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.credName} numberOfLines={1}>{key.description || key.id}</Text>
                <Text style={styles.credMeta} numberOfLines={2}>
                  {[
                    key.emailAddresses.join(', '),
                    key.expiresAt
                      ? t('settings.security.public_keys.expires', 'expires {date}', { date: new Date(key.expiresAt).toLocaleDateString() })
                      : null,
                  ].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <Pressable
                style={styles.iconBtn}
                onPress={() => remove(key)}
                disabled={removingId !== null}
                accessibilityRole="button"
                accessibilityLabel={t('common.remove', 'Remove')}
              >
                {removingId === key.id
                  ? <ActivityIndicator size="small" color={c.error} />
                  : <Trash2 size={16} color={c.error} />}
              </Pressable>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.emptyText}>{t('settings.security.public_keys.none', 'No public keys configured')}</Text>
      )}
    </View>
  );
}

// ── Encryption at rest ────────────────────────────────────
function EncryptionSection({
  info,
  keys,
  onChanged,
}: {
  info: CryptoInfo;
  keys: PublicKeyInfo[];
  onChanged: () => Promise<void>;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [type, setType] = useState<EncryptionType>(info.type);
  const [keyId, setKeyId] = useState<string | null>(info.publicKeyId ?? keys[0]?.id ?? null);
  const [encryptOnAppend, setEncryptOnAppend] = useState(info.encryptOnAppend);
  const [allowSpamTraining, setAllowSpamTraining] = useState(info.allowSpamTraining);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setType(info.type);
    setKeyId(info.publicKeyId ?? keys[0]?.id ?? null);
    setEncryptOnAppend(info.encryptOnAppend);
    setAllowSpamTraining(info.allowSpamTraining);
  }, [info, keys]);

  const enabled = type !== 'Disabled';
  const dirty =
    type !== info.type
    || (enabled && keyId !== info.publicKeyId)
    || (enabled && encryptOnAppend !== info.encryptOnAppend)
    || (enabled && allowSpamTraining !== info.allowSpamTraining);

  const save = async () => {
    setSaving(true);
    try {
      await updateEncryptionAtRest({ type, publicKeyId: keyId, encryptOnAppend, allowSpamTraining });
      await onChanged();
      Alert.alert(
        t('settings.security.encryption.section_title', 'Encryption at Rest'),
        enabled
          ? t('settings.security.encryption.enabled_success', 'Encryption at rest enabled')
          : t('settings.security.encryption.disabled_success', 'Encryption at rest disabled'),
      );
    } catch (err) {
      Alert.alert(
        t('settings.security.encryption.error', 'Failed to update encryption settings'),
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  const algorithms: { value: EncryptionType; label: string }[] = [
    { value: 'Disabled', label: t('settings.security.encryption.inactive', 'Disabled') },
    { value: 'Aes128', label: 'AES-128' },
    { value: 'Aes256', label: 'AES-256' },
  ];

  return (
    <View style={{ gap: spacing.md }}>
      <View style={styles.headerRow}>
        <Lock size={16} color={c.mutedForeground} />
        <Text style={styles.headerTitle}>{t('settings.security.encryption.section_title', 'Encryption at Rest')}</Text>
      </View>
      <Text style={styles.panelHint}>
        {t('settings.security.encryption.description', 'Encrypt stored emails on the server for additional privacy')}
        {' '}
        {info.type !== 'Disabled'
          ? t('settings.security.encryption.active', '{type} encryption enabled', { type: info.type })
          : t('settings.security.encryption.inactive', 'Disabled')}
      </Text>

      <View>
        <Text style={styles.pwLabel}>{t('settings.security.encryption.algorithm_label', 'Encryption Algorithm')}</Text>
        <View style={styles.rowGap}>
          {algorithms.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={type === opt.value ? 'default' : 'outline'}
              onPress={() => setType(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </View>
      </View>

      {enabled && (
        <View style={styles.panel}>
          <Text style={styles.pwLabel}>{t('settings.security.public_keys.title', 'Public Keys')}</Text>
          {keys.length === 0 ? (
            <Text style={styles.errorText}>
              {t('settings.security.encryption.no_keys', 'Add a public key first - encryption at rest needs one.')}
            </Text>
          ) : (
            <View style={{ gap: spacing.xs }}>
              {keys.map((key) => (
                <Pressable
                  key={key.id}
                  onPress={() => setKeyId(key.id)}
                  style={styles.keyChoice}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: keyId === key.id }}
                >
                  {keyId === key.id ? <Check size={14} color={c.primary} /> : <View style={{ width: 14 }} />}
                  <Text style={styles.credName} numberOfLines={1}>{key.description || key.id}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <SettingItem
            label={t('settings.security.encryption.encrypt_on_append', 'Encrypt new emails on upload')}
            noBorder
          >
            <ToggleSwitch checked={encryptOnAppend} onChange={setEncryptOnAppend} />
          </SettingItem>
          <SettingItem
            label={t('settings.security.encryption.allow_spam_training', 'Allow spam training before encrypting emails')}
            noBorder
          >
            <ToggleSwitch checked={allowSpamTraining} onChange={setAllowSpamTraining} />
          </SettingItem>
        </View>
      )}

      <View style={{ alignItems: 'flex-start' }}>
        <Button
          size="sm"
          loading={saving}
          disabled={saving || !dirty || (enabled && !keyId)}
          onPress={() => { void save(); }}
        >
          {t('common.save', 'Save')}
        </Button>
      </View>
    </View>
  );
}

// Screen protection: device-wide, kept with the app settings rather than the
// account. Widgets and notification previews still show mail.
function ScreenProtectionSection() {
  const t = useLocaleStore((s) => s.t);
  const blockScreenshots = useSettingsStore((s) => s.blockScreenshots);
  const hideInRecents = useSettingsStore((s) => s.hideInRecents);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  return (
    <SettingsSection
      title={t('settings.security.screen_protection.title', 'Screen protection')}
      description={t('settings.security.screen_protection.description', 'Keeps mail out of screenshots and the recent apps view on this device. Home-screen widgets and notification previews still show mail.')}
    >
      <SettingItem
        label={t('settings.security.screen_protection.block_screenshots.label', 'Block screenshots')}
        description={t('settings.security.screen_protection.block_screenshots.description', 'Blocks screenshots, screen recording and casting, and blanks the app in recent apps.')}
      >
        <ToggleSwitch checked={blockScreenshots} onChange={(v) => updateSetting('blockScreenshots', v)} />
      </SettingItem>
      {supportsRecentsHiding() && (
        <SettingItem
          label={t('settings.security.screen_protection.hide_in_recents.label', 'Hide in recent apps only')}
          description={t('settings.security.screen_protection.hide_in_recents.description', 'Blanks the app in recent apps but still allows screenshots. The app can show briefly while you switch apps; use Block screenshots to hide it completely.')}
          noBorder
        >
          <ToggleSwitch checked={hideInRecents} onChange={(v) => updateSetting('hideInRecents', v)} />
        </SettingItem>
      )}
    </SettingsSection>
  );
}

// ── Screen ────────────────────────────────────────────────
export function AccountSecuritySettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const certSupported = isClientCertSupported();
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  // Read at render for the layout; the load effect re-reads it after a switch.
  const isOAuth = jmapClient.usesBearerAuth;

  // null = still probing; false = server lacks the Stalwart extension.
  const [supported, setSupported] = useState<boolean | null>(null);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const t = useLocaleStore((s) => s.t);
  const tRef = React.useRef(t);
  tRef.current = t;
  const [displayName, setDisplayName] = useState('');
  const [crypto, setCrypto] = useState<CryptoInfo | null>(null);
  const [publicKeys, setPublicKeys] = useState<PublicKeyInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  const reloadCrypto = useCallback(async (isCancelled: () => boolean = () => false) => {
    const [info, keys] = await Promise.allSettled([fetchCryptoInfo(), fetchPublicKeys()]);
    if (isCancelled()) return;
    if (info.status === 'fulfilled') setCrypto(info.value);
    if (keys.status === 'fulfilled') setPublicKeys(keys.value);
  }, []);

  const reloadAuth = useCallback(async () => {
    try {
      setAuth(await fetchAuthInfo());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('settings.security.load_error', 'Failed to load security settings.'));
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    // A switched-to account must not show, or edit, the previous one's data.
    setAuth(null);
    setDisplayName('');
    setLoadError(null);
    setCrypto(null);
    setPublicKeys([]);
    const loadIsOAuth = jmapClient.usesBearerAuth;
    const session = jmapClient.currentSession;
    if (!session) { setOffline(true); setSupported(false); return; }
    setOffline(false);
    if (!isStalwartSupported()) { setSupported(false); return; }
    setSupported(true);

    (async () => {
      try {
        const authInfo = await fetchAuthInfo();
        if (cancelled) return;
        setAuth(authInfo);
        // The name is readable by everyone (x:AccountSettings); the principal is
        // admin-only, so it is just the fallback. Failures are non-fatal, and
        // caught at once: a quick one would otherwise go unhandled while the
        // principal loads.
        const namePromise = fetchAccountDisplayName().catch(() => null);
        let principalName = '';
        if (!loadIsOAuth) {
          // Principal + crypto only matter for password accounts.
          const [principal] = await Promise.allSettled([fetchPrincipal(), reloadCrypto(() => cancelled)]);
          if (principal.status === 'fulfilled') principalName = principal.value.displayName;
        }
        const accountName = await namePromise;
        if (cancelled) return;
        setDisplayName(accountName || principalName);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : tRef.current('settings.security.load_error', 'Failed to load security settings.'));
      }
    })();

    return () => { cancelled = true; };
    // t is read through a ref: a locale change must not wipe loaded fields.
  }, [activeAccountId, reloadCrypto]);

  return (
    <View style={styles.container}>
      {supportsScreenPrivacy() && <ScreenProtectionSection />}
      {certSupported && <ClientCertSection />}

      {supported === null && (
        <View style={styles.loadingRow}>
          <ActivityIndicator color={c.mutedForeground} />
          <Text style={styles.panelHint}>{t('settings.security.detecting', "Detecting server features…")}</Text>
        </View>
      )}

      {supported === false && (
        <SettingsSection
          title={t('settings.security.title', 'Account Security')}
          description={t('settings.security.description', 'Manage your password, two-factor authentication, and security settings')}
        >
          <Text style={styles.emptyText}>
            {offline
              ? t('settings.security.offline', 'You are offline. Account security settings need a live connection to the server.')
              : t('settings.security.not_supported', 'Account security management requires a Stalwart server. These features are not available for this account.')}
          </Text>
        </SettingsSection>
      )}

      {supported && (
        <SettingsSection
          title={t('settings.security.title', 'Account Security')}
          description={t('settings.security.description', 'Manage your password, two-factor authentication, and security settings')}
        >
          <View style={{ gap: spacing.xxxl }}>
            {loadError ? <Text style={styles.errorText}>{loadError}</Text> : null}

            {!isOAuth && (
              <>
                <PasswordChangeSection otpEnabled={!!auth?.otpEnabled} />
                <DisplayNameSection initial={displayName} onSaved={setDisplayName} />
                <TotpSection enabled={!!auth?.otpEnabled} onChanged={() => { void reloadAuth(); }} />
              </>
            )}

            <CredentialSection
              icon={Smartphone}
              title={t('settings.security.app_passwords.title', "App Passwords")}
              description={t('settings.security.app_passwords.description', "Generate passwords for other mail clients that can't do interactive login.")}
              nameLabel={t('settings.security.app_passwords.name_label', "Name")}
              namePlaceholder={t('settings.security.app_passwords.name_placeholder', "e.g. Thunderbird laptop")}
              entries={auth?.appPasswords ?? []}
              onCreate={async (input) => { const r = await createAppPassword(input); await reloadAuth(); return r; }}
              onRemove={async (id) => { await removeAppPassword(id); await reloadAuth(); }}
            />

            <CredentialSection
              icon={Terminal}
              title={t('settings.security.api_keys.title', "API Keys")}
              description={t('settings.security.api_keys.description', "Create API keys for scripts and integrations that talk to the server directly")}
              nameLabel={t('settings.security.api_keys.name_label', "Key Name")}
              namePlaceholder={t('settings.security.api_keys.name_placeholder', "e.g. Backup script, CI runner")}
              entries={auth?.apiKeys ?? []}
              onCreate={async (input) => { const r = await createApiKey(input); await reloadAuth(); return r; }}
              onRemove={async (id) => { await removeApiKey(id); await reloadAuth(); }}
            />

            {isOAuth && <EmailClientSection />}
            {!isOAuth && (
              <>
                <PublicKeysSection keys={publicKeys} onChanged={() => reloadCrypto()} />
                {crypto && <EncryptionSection info={crypto} keys={publicKeys} onChanged={() => reloadCrypto()} />}
              </>
            )}
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
    keyChoice: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
    emptyText: { ...typography.caption, color: c.mutedForeground, fontStyle: 'italic' },

    // TLS client cert
    certRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.md },
    certStatus: { ...typography.bodyMedium, color: c.text },
    certHint: { ...typography.caption, color: c.mutedForeground, marginTop: 4 },
  });
}
