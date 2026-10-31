import React from 'react';
import { View, Text, StyleSheet, Alert, Share, Modal, TextInput, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { SettingsSection, SettingItem } from './settings-section';
import Button from '../Button';
import Dialog from '../Dialog';
import { UnlockKeyDialog } from '../crypto/UnlockKeyDialog';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useCryptoKeysStore, isRecordCurrent, type CryptoKeyRecord } from '../../stores/crypto-keys-store';
import { toast } from '../../stores/toast-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { useSheetBottomInset } from '../../lib/sheet-bottom-inset';
import {
  importPgpKey, importPkcs12File, importCertificate, deleteKey, exportPublic, isUnlocked, lockAll, onUnlockChange, needsPassphrase, unlock,
} from '../../lib/crypto/keyring';
import { formatFingerprint, keyLabel, shortDate, shortFingerprint } from '../../lib/crypto/key-labels';
import { lookupKey, type KeyLookupResult } from '../../lib/crypto/keyserver';
import { PgpWrongPassphraseError } from '../../lib/crypto/pgp';
import type { SelfTestResult } from '../../lib/crypto/self-test';

type Translate = (key: string, fallback: string, vars?: Record<string, string | number>) => string;

async function pickFileBytes(types: string[]): Promise<{ bytes: Uint8Array; name: string } | null> {
  const picked = await DocumentPicker.getDocumentAsync({ type: types, copyToCacheDirectory: true, multiple: false });
  if (picked.canceled || !picked.assets?.[0]) return null;
  const asset = picked.assets[0];
  return { bytes: await new File(asset.uri).bytes(), name: asset.name ?? '' };
}

function errorText(err: unknown, t: Translate): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/wrong passphrase|incorrect key passphrase|wrong password/i.test(msg)) return t('encryption.wrong_passphrase', 'That passphrase is not right.');
  if (/Misformed armored text|Unknown ASCII armor|No valid key|not a PGP|Invalid PKCS#12|ASN\.1/i.test(msg)) return t('encryption.not_a_key', 'This is not a key or certificate the app can read.');
  return msg;
}

/** Use an unlocked key's state in render; re-renders on lock/unlock. */
function useUnlockTick(): number {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => onUnlockChange(() => setTick((n) => n + 1)), []);
  return tick;
}

/**
 * Settings → Encryption (#58): your PGP keys and S/MIME certificates, other
 * people's public keys and certificates, keyserver lookup, and a check of
 * the device's crypto. The webmail has this in its plugins' settings
 * sections (repos/plugins/bulwark-gpg/src/index.js SettingsSection,
 * repos/plugins/smime/src/ui.js SettingsSection).
 */
export function EncryptionSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const keys = useCryptoKeysStore((s) => s.keys);
  useUnlockTick();

  const own = React.useMemo(() => keys.filter((k) => k.hasPrivate), [keys]);
  const others = React.useMemo(() => keys.filter((k) => !k.hasPrivate), [keys]);

  const [busy, setBusy] = React.useState(false);
  const [unlockRecord, setUnlockRecord] = React.useState<CryptoKeyRecord | null>(null);
  const [deleteRecord, setDeleteRecord] = React.useState<CryptoKeyRecord | null>(null);
  const [pasteMode, setPasteMode] = React.useState<'private' | 'public' | null>(null);
  const [pendingPrivate, setPendingPrivate] = React.useState<string | null>(null);
  const [pendingP12, setPendingP12] = React.useState<Uint8Array | null>(null);
  const [secret, setSecret] = React.useState('');
  const [secretError, setSecretError] = React.useState<string | null>(null);
  const [lookupOpen, setLookupOpen] = React.useState(false);
  const [selfTest, setSelfTest] = React.useState<SelfTestResult[] | null>(null);
  const [selfTestRunning, setSelfTestRunning] = React.useState(false);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      Alert.alert(t('encryption.tab', 'Encryption'), errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  // ── import flows ──
  const importArmored = async (armored: string, kind: 'private' | 'public') => {
    if (kind === 'public' || !/BEGIN PGP PRIVATE KEY/.test(armored)) {
      const record = await importPgpKey(armored);
      toast.success(t('encryption.imported', 'Imported {key}', { key: keyLabel(record) }));
      return;
    }
    // Ask for the passphrase only when the key has one.
    try {
      const record = await importPgpKey(armored, '');
      toast.success(t('encryption.imported', 'Imported {key}', { key: keyLabel(record) }));
    } catch (err) {
      if (err instanceof PgpWrongPassphraseError) {
        setSecret('');
        setSecretError(null);
        setPendingPrivate(armored);
        return;
      }
      throw err;
    }
  };

  const pickPgpFile = (kind: 'private' | 'public') => run(async () => {
    const file = await pickFileBytes(['application/pgp-keys', 'text/plain', '*/*']);
    if (!file) return;
    await importArmored(new TextDecoder('utf-8', { fatal: false }).decode(file.bytes), kind);
  });

  const pickP12 = () => run(async () => {
    const file = await pickFileBytes(['application/x-pkcs12', '*/*']);
    if (!file) return;
    setSecret('');
    setSecretError(null);
    setPendingP12(file.bytes);
  });

  const pickCertificate = () => run(async () => {
    const file = await pickFileBytes(['application/pkix-cert', 'application/x-x509-ca-cert', 'application/x-pem-file', '*/*']);
    if (!file) return;
    const record = await importCertificate(file.bytes);
    toast.success(t('encryption.imported', 'Imported {key}', { key: keyLabel(record) }));
  });

  const submitSecret = async () => {
    setBusy(true);
    setSecretError(null);
    try {
      const record = pendingPrivate ? await importPgpKey(pendingPrivate, secret) : await importPkcs12File(pendingP12!, secret);
      setPendingPrivate(null);
      setPendingP12(null);
      setSecret('');
      toast.success(t('encryption.imported', 'Imported {key}', { key: keyLabel(record) }));
    } catch (err) {
      setSecretError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  const share = (record: CryptoKeyRecord) => run(async () => {
    await Share.share({ message: await exportPublic(record), title: keyLabel(record) });
  });

  const onUnlockPress = (record: CryptoKeyRecord) => run(async () => {
    if (await needsPassphrase(record)) setUnlockRecord(record);
    else await unlock(record, '');
  });

  const runSelfTest = async () => {
    setSelfTestRunning(true);
    try {
      const { runCryptoSelfTest } = await import('../../lib/crypto/self-test');
      setSelfTest(await runCryptoSelfTest());
    } finally {
      setSelfTestRunning(false);
    }
  };

  const keyRow = (record: CryptoKeyRecord, mine: boolean) => {
    const kindLabel = record.kind === 'pgp' ? 'PGP' : 'S/MIME';
    const expires = record.kind === 'pgp' ? record.expiration : record.notAfter;
    const current = isRecordCurrent(record);
    const details = [
      `${kindLabel} · ${record.algorithm}`,
      shortFingerprint(record.fingerprint),
      expires ? (current ? t('encryption.expires', 'Expires {date}', { date: shortDate(expires) }) : t('encryption.expired', 'Expired {date}', { date: shortDate(expires) })) : null,
      mine ? (isUnlocked(record) ? t('encryption.unlocked', 'Unlocked') : t('encryption.locked', 'Locked')) : null,
    ].filter(Boolean).join('\n');
    return (
      <SettingItem key={`${record.kind}:${record.id}`} label={keyLabel(record)} description={details}>
        <View style={styles.rowActions}>
          {mine && !isUnlocked(record) && (
            <Button size="sm" variant="outline" onPress={() => onUnlockPress(record)}>{t('encryption.unlock', 'Unlock')}</Button>
          )}
          <Button size="sm" variant="outline" onPress={() => share(record)}>
            {record.kind === 'pgp' ? t('encryption.share_key', 'Share public key') : t('encryption.share_cert', 'Share certificate')}
          </Button>
          <Button size="sm" variant="destructiveOutline" onPress={() => setDeleteRecord(record)}>{t('common.delete', 'Delete')}</Button>
        </View>
      </SettingItem>
    );
  };

  return (
    <View style={styles.container}>
      <SettingsSection
        title={t('encryption.own_title', 'Your keys')}
        description={t('encryption.own_description', 'Sign and decrypt mail with OpenPGP or S/MIME. Private keys stay in this device\'s secure storage and are unlocked with their passphrase once per app session.')}
      >
        {own.length === 0 && <Text style={styles.empty}>{t('encryption.no_own_keys', 'No keys yet.')}</Text>}
        {own.map((k) => keyRow(k, true))}
        <View style={styles.buttons}>
          <Button size="sm" variant="outline" disabled={busy} onPress={() => pickPgpFile('private')}>{t('encryption.import_pgp_file', 'Import PGP key file')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onPress={() => setPasteMode('private')}>{t('encryption.paste_pgp', 'Paste PGP key')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onPress={pickP12}>{t('encryption.import_p12', 'Import S/MIME certificate (.p12)')}</Button>
        </View>
        {own.some((k) => isUnlocked(k)) && (
          <SettingItem label={t('encryption.lock_all', 'Lock all keys')} description={t('encryption.lock_all_description', 'Forget the unlocked keys until you enter their passphrase again.')} noBorder>
            <Button size="sm" variant="outline" onPress={() => { lockAll(); toast.info(t('encryption.locked_all', 'Keys locked')); }}>{t('encryption.lock', 'Lock')}</Button>
          </SettingItem>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('encryption.others_title', 'Other people\'s keys')}
        description={t('encryption.others_description', 'Public keys and certificates to encrypt to and to check signatures with. Keys from signed mail and keys in your contacts are used too.')}
      >
        {others.length === 0 && <Text style={styles.empty}>{t('encryption.no_other_keys', 'None yet.')}</Text>}
        {others.map((k) => keyRow(k, false))}
        <View style={styles.buttons}>
          <Button size="sm" variant="outline" disabled={busy} onPress={() => pickPgpFile('public')}>{t('encryption.import_public_file', 'Import public key file')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onPress={() => setPasteMode('public')}>{t('encryption.paste_public', 'Paste public key')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onPress={pickCertificate}>{t('encryption.import_cert', 'Import certificate')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onPress={() => setLookupOpen(true)}>{t('encryption.find_key', 'Find a key on keys.openpgp.org')}</Button>
        </View>
      </SettingsSection>

      <SettingsSection
        title={t('encryption.check_title', 'Check encryption support')}
        description={t('encryption.check_description', 'Runs every algorithm PGP and S/MIME use on this device.')}
      >
        <View style={styles.buttons}>
          <Button size="sm" variant="outline" loading={selfTestRunning} disabled={selfTestRunning} onPress={() => void runSelfTest()}>{t('encryption.check_run', 'Run check')}</Button>
        </View>
        {selfTest && selfTest.map((r) => (
          <Text key={r.name} style={[styles.checkRow, { color: r.ok ? c.success : c.error }]}>
            {`${r.ok ? '✓' : '✗'} ${r.name}${r.error ? ` — ${r.error}` : ''}`}
          </Text>
        ))}
      </SettingsSection>

      <UnlockKeyDialog record={unlockRecord} onUnlocked={() => setUnlockRecord(null)} onCancel={() => setUnlockRecord(null)} />

      <Dialog
        visible={!!pendingPrivate || !!pendingP12}
        title={pendingP12 ? t('encryption.p12_password_title', 'Certificate password') : t('encryption.passphrase_title', 'Key passphrase')}
        message={[
          pendingP12
            ? t('encryption.p12_password_message', 'Enter the password the .p12 file was exported with. You will need it again to unlock the key after the app restarts.')
            : t('encryption.passphrase_message', 'Enter the passphrase of this key. It is checked now and asked again once per app session.'),
          secretError,
        ].filter(Boolean).join('\n\n')}
        confirmText={t('encryption.import', 'Import')}
        confirmDisabled={busy}
        input={{ value: secret, onChangeText: setSecret, placeholder: pendingP12 ? t('encryption.password', 'Password') : t('encryption.passphrase', 'Passphrase'), props: { secureTextEntry: true, autoCapitalize: 'none', autoCorrect: false } }}
        onConfirm={() => void submitSecret()}
        onCancel={() => { setPendingPrivate(null); setPendingP12(null); setSecret(''); }}
      />

      <Dialog
        visible={!!deleteRecord}
        variant="destructive"
        title={t('encryption.delete_title', 'Delete key?')}
        message={deleteRecord?.hasPrivate
          ? t('encryption.delete_private_message', '{key} and its private key are removed from this device. Mail encrypted to it can no longer be read here unless you import it again.', { key: deleteRecord ? keyLabel(deleteRecord) : '' })
          : t('encryption.delete_public_message', '{key} is removed from this device.', { key: deleteRecord ? keyLabel(deleteRecord) : '' })}
        confirmText={t('common.delete', 'Delete')}
        onConfirm={() => { const r = deleteRecord; setDeleteRecord(null); if (r) void run(() => deleteKey(r)); }}
        onCancel={() => setDeleteRecord(null)}
      />

      <PasteKeySheet
        mode={pasteMode}
        onClose={() => setPasteMode(null)}
        onSubmit={(text) => { const mode = pasteMode!; setPasteMode(null); void run(() => importArmored(text, mode)); }}
      />

      <KeyLookupSheet visible={lookupOpen} onClose={() => setLookupOpen(false)} />
    </View>
  );
}

function PasteKeySheet({ mode, onClose, onSubmit }: { mode: 'private' | 'public' | null; onClose: () => void; onSubmit: (text: string) => void }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [text, setText] = React.useState('');
  const bottomInset = useSheetBottomInset(!!mode);
  React.useEffect(() => { if (mode) setText(''); }, [mode]);
  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={!!mode} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessible={false} style={[styles.backdrop, { paddingBottom: spacing.lg + bottomInset }]} onPress={onClose}>
        <Pressable accessible={false} style={styles.card} onPress={() => {}}>
          <Text style={styles.cardTitle} accessibilityRole="header">
            {mode === 'private' ? t('encryption.paste_pgp', 'Paste PGP key') : t('encryption.paste_public', 'Paste public key')}
          </Text>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="-----BEGIN PGP ... KEY BLOCK-----"
            placeholderTextColor={c.mutedForeground}
            style={styles.textArea}
            accessibilityLabel={t('encryption.armored_key', 'Armored key')}
          />
          <View style={styles.footer}>
            <Button size="sm" variant="outline" onPress={onClose}>{t('common.cancel', 'Cancel')}</Button>
            <Button size="sm" disabled={!/-----BEGIN PGP/.test(text)} onPress={() => onSubmit(text)}>{t('encryption.import', 'Import')}</Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function KeyLookupSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [query, setQuery] = React.useState('');
  const [result, setResult] = React.useState<KeyLookupResult | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [searching, setSearching] = React.useState(false);
  const bottomInset = useSheetBottomInset(visible);
  React.useEffect(() => {
    if (visible) { setQuery(''); setResult(null); setMessage(null); }
  }, [visible]);

  const search = async () => {
    setSearching(true);
    setResult(null);
    setMessage(null);
    try {
      const found = await lookupKey(query);
      if (!found) setMessage(t('encryption.lookup_none', 'No key found.'));
      else setResult(found);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const importFound = async () => {
    if (!result) return;
    try {
      const record = await importPgpKey(result.armored, undefined, 'keyserver');
      toast.success(t('encryption.imported', 'Imported {key}', { key: keyLabel(record) }));
      onClose();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessible={false} style={[styles.backdrop, { paddingBottom: spacing.lg + bottomInset }]} onPress={onClose}>
        <Pressable accessible={false} style={styles.card} onPress={() => {}}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.cardTitle} accessibilityRole="header">{t('encryption.find_key', 'Find a key on keys.openpgp.org')}</Text>
            <TextInput
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder={t('encryption.lookup_placeholder', 'Email address or fingerprint')}
              placeholderTextColor={c.mutedForeground}
              onSubmitEditing={() => void search()}
              style={styles.input}
              accessibilityLabel={t('encryption.lookup_placeholder', 'Email address or fingerprint')}
            />
            {searching && <ActivityIndicator color={c.primary} style={{ marginTop: spacing.md }} />}
            {message && <Text style={styles.lookupMessage}>{message}</Text>}
            {result && (
              <View style={styles.lookupResult}>
                <Text style={styles.lookupUser}>{result.info.userIDs.map((u) => u.raw).join('\n') || result.info.keyID}</Text>
                <Text style={styles.fingerprint} selectable>{formatFingerprint(result.info.fingerprint)}</Text>
                <Text style={[styles.lookupMessage, { color: result.verified ? c.success : c.warning }]}>
                  {result.verified
                    ? t('encryption.lookup_verified', 'The key has the fingerprint you searched for.')
                    : t('encryption.lookup_confirm', 'Compare this fingerprint with the one the owner gave you (in person, by phone) before you import it.')}
                </Text>
              </View>
            )}
            <View style={styles.footer}>
              <Button size="sm" variant="outline" onPress={onClose}>{t('common.cancel', 'Cancel')}</Button>
              {result
                ? <Button size="sm" onPress={() => void importFound()}>{t('encryption.import', 'Import')}</Button>
                : <Button size="sm" disabled={!query.trim() || searching} onPress={() => void search()}>{t('encryption.lookup_search', 'Search')}</Button>}
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { gap: spacing.xxl },
    empty: { ...typography.body, color: c.textMuted, paddingVertical: spacing.sm },
    buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingVertical: spacing.md },
    rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, justifyContent: 'flex-end' },
    checkRow: { ...typography.caption, paddingVertical: 2 },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
    card: {
      width: '100%', maxWidth: 480, maxHeight: '90%', backgroundColor: c.background, borderRadius: radius.md,
      borderWidth: 1, borderColor: c.border, padding: spacing.lg, gap: spacing.sm,
    },
    cardTitle: { ...typography.h3, color: c.text, marginBottom: spacing.sm },
    textArea: {
      minHeight: 160, maxHeight: 320, borderWidth: 1, borderColor: c.border, borderRadius: radius.sm, padding: spacing.sm,
      color: c.text, fontFamily: 'monospace', fontSize: 12, textAlignVertical: 'top',
    },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: c.text, ...typography.body },
    footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
    lookupMessage: { ...typography.caption, color: c.textMuted, marginTop: spacing.sm },
    lookupResult: { marginTop: spacing.md, gap: spacing.xs },
    lookupUser: { ...typography.bodyMedium, color: c.text },
    fingerprint: { fontFamily: 'monospace', fontSize: 13, color: c.text },
  });
}
