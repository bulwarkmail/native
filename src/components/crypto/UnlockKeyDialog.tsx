import React from 'react';
import Dialog from '../Dialog';
import { useLocaleStore } from '../../stores/locale-store';
import type { CryptoKeyRecord } from '../../stores/crypto-keys-store';
import { unlock } from '../../lib/crypto/keyring';
import { keyLabel } from '../../lib/crypto/key-labels';

/**
 * Asks for the passphrase of a PGP key or the password of an S/MIME .p12
 * and unlocks it for this session (the plugins' unlock prompt). A wrong
 * passphrase keeps the dialog open with the reason.
 */
export function UnlockKeyDialog({
  record, reason, onUnlocked, onCancel,
}: {
  /** The key to unlock; null hides the dialog. */
  record: CryptoKeyRecord | null;
  /** Why it is needed ("to read this message", "to sign"). */
  reason?: string;
  onUnlocked: () => void;
  onCancel: () => void;
}) {
  const t = useLocaleStore((s) => s.t);
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setValue('');
    setError(null);
    setBusy(false);
  }, [record?.id]);

  if (!record) return null;
  const label = keyLabel(record);
  const message = [
    record.kind === 'pgp'
      ? t('encryption.unlock_pgp_message', 'Enter the passphrase of your PGP key {key}.', { key: label })
      : t('encryption.unlock_smime_message', 'Enter the password of your S/MIME certificate {key}.', { key: label }),
    reason,
    error,
  ].filter(Boolean).join('\n\n');

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(record, value);
      setValue('');
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error && /passphrase|password/i.test(err.message)
        ? t('encryption.wrong_passphrase', 'That passphrase is not right.')
        : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      visible
      title={t('encryption.unlock_title', 'Unlock key')}
      message={message}
      confirmText={busy ? t('encryption.unlocking', 'Unlocking…') : t('encryption.unlock', 'Unlock')}
      confirmDisabled={busy || (record.kind === 'smime' ? false : value.length === 0)}
      input={{
        value,
        onChangeText: setValue,
        placeholder: record.kind === 'pgp' ? t('encryption.passphrase', 'Passphrase') : t('encryption.password', 'Password'),
        props: { secureTextEntry: true, autoCapitalize: 'none', autoCorrect: false, textContentType: 'password' },
      }}
      onConfirm={() => void submit()}
      onCancel={() => {
        setValue('');
        onCancel();
      }}
    />
  );
}
