import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
  Upload, Trash2, Eye, Lock, Unlock, Download,
  ShieldCheck, ShieldAlert, Users,
} from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch, Select } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

interface KeyRecord {
  id: string;
  email: string;
  subject: string;
  issuer: string;
  notAfter: string;
  algorithm: string;
  unlocked?: boolean;
}

interface PublicCert {
  id: string;
  email: string;
  subject: string;
  issuer: string;
  notAfter: string;
  source: string;
}

const MOCK_KEYS: KeyRecord[] = [];
const MOCK_CERTS: PublicCert[] = [];

export function SmimeSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [keys, setKeys] = useState<KeyRecord[]>(MOCK_KEYS);
  const [certs, setCerts] = useState<PublicCert[]>(MOCK_CERTS);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [defaultEncrypt, setDefaultEncrypt] = useState(false);
  const [rememberUnlocked, setRememberUnlocked] = useState(false);
  const [autoImport, setAutoImport] = useState(true);

  const isExpired = (d: string) => new Date(d) < new Date();
  const formatDate = (d: string) => {
    try { return new Date(d).toLocaleDateString(); } catch { return d; }
  };

  const toggleUnlock = (id: string) => {
    setKeys((ks) => ks.map((k) => k.id === id ? { ...k, unlocked: !k.unlocked } : k));
  };

  const deleteKey = (id: string) => setKeys((ks) => ks.filter((k) => k.id !== id));
  const deleteCert = (id: string) => setCerts((cs) => cs.filter((c) => c.id !== id));

  return (
    <View style={styles.container}>
      <SettingsSection
        title="Your Certificates"
        description="Private keys used to sign and decrypt mail."
      >
        <View style={{ gap: spacing.sm }}>
          {keys.map((k) => {
            const expired = isExpired(k.notAfter);
            return (
              <View key={k.id} style={styles.certRow}>
                <View style={styles.certLeft}>
                  <View style={[styles.certIcon, expired ? styles.certIconError : styles.certIconOk]}>
                    {expired ? (
                      <ShieldAlert size={16} color={c.error} />
                    ) : (
                      <ShieldCheck size={16} color={c.primary} />
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.certName} numberOfLines={1}>{k.email || k.subject}</Text>
                    <Text style={styles.certMeta}>
                      {k.issuer} · Expires {formatDate(k.notAfter)}
                      {expired && <Text style={styles.expiredText}> (Expired)</Text>}
                    </Text>
                  </View>
                </View>
                <View style={styles.certActions}>
                  <Pressable style={styles.iconBtn} onPress={() => toggleUnlock(k.id)}>
                    {k.unlocked ? (
                      <Unlock size={16} color={c.success} />
                    ) : (
                      <Lock size={16} color={c.text} />
                    )}
                  </Pressable>
                  <Pressable style={styles.iconBtn}>
                    <Eye size={16} color={c.text} />
                  </Pressable>
                  <Pressable style={styles.iconBtn}>
                    <Download size={16} color={c.text} />
                  </Pressable>
                  <Pressable style={styles.iconBtn} onPress={() => deleteKey(k.id)}>
                    <Trash2 size={16} color={c.error} />
                  </Pressable>
                </View>
              </View>
            );
          })}

          {keys.length === 0 && (
            <Text style={styles.empty}>No certificates imported.</Text>
          )}
        </View>

        <View style={{ alignItems: 'flex-start', marginTop: spacing.sm }}>
          <Button variant="outline" size="sm" icon={<Upload size={14} color={c.text} />}>
            Import PKCS#12
          </Button>
        </View>
      </SettingsSection>

      <SettingsSection
        title="Recipient Certificates"
        description="Public certificates used to encrypt outgoing mail."
      >
        <View style={{ gap: spacing.sm }}>
          {certs.map((c) => {
            const expired = isExpired(c.notAfter);
            return (
              <View key={c.id} style={styles.certRow}>
                <View style={styles.certLeft}>
                  <View style={[styles.certIcon, styles.certIconMuted]}>
                    <Users size={16} color={c.mutedForeground} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.certName} numberOfLines={1}>{c.email || c.subject}</Text>
                    <Text style={styles.certMeta}>
                      {c.issuer} · {c.source}
                      {expired && <Text style={styles.expiredText}> (Expired)</Text>}
                    </Text>
                  </View>
                </View>
                <View style={styles.certActions}>
                  <Pressable style={styles.iconBtn}>
                    <Eye size={16} color={c.text} />
                  </Pressable>
                  <Pressable style={styles.iconBtn} onPress={() => deleteCert(c.id)}>
                    <Trash2 size={16} color={c.error} />
                  </Pressable>
                </View>
              </View>
            );
          })}

          {certs.length === 0 && (
            <Text style={styles.empty}>No recipient certificates.</Text>
          )}
        </View>

        <View style={{ alignItems: 'flex-start', marginTop: spacing.sm }}>
          <Button variant="outline" size="sm" icon={<Upload size={14} color={c.text} />}>
            Import Certificate
          </Button>
        </View>
      </SettingsSection>

      <SettingsSection
        title="Defaults"
        description="Defaults for new outgoing messages."
      >
        <SettingItem
          label="Encrypt by default"
          description="Encrypt new messages when recipient certificates are available."
        >
          <ToggleSwitch checked={defaultEncrypt} onChange={setDefaultEncrypt} />
        </SettingItem>

        <SettingItem
          label="Remember unlocked keys"
          description="Keep private keys unlocked across the session."
        >
          <ToggleSwitch checked={rememberUnlocked} onChange={setRememberUnlocked} />
        </SettingItem>

        <SettingItem
          label="Auto-import signer certs"
          description="Save public certificates from signed messages."
        >
          <ToggleSwitch checked={autoImport} onChange={setAutoImport} />
        </SettingItem>
      </SettingsSection>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { gap: spacing.xxxl },
  certRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
  },
  certLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
    minWidth: 0,
  },
  certIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  certIconOk: { backgroundColor: c.primaryBg },
  certIconError: { backgroundColor: c.errorBg },
  certIconMuted: { backgroundColor: c.muted },
  certName: { ...typography.bodyMedium, color: c.text },
  certMeta: { ...typography.caption, color: c.mutedForeground, marginTop: 2 },
  expiredText: { color: c.error },
  certActions: { flexDirection: 'row', gap: 2 },
  iconBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  empty: {
    ...typography.body,
    color: c.mutedForeground,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
});
}
