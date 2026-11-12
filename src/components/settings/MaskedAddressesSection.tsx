// Masked addresses under Settings > Security (webmail
// components/settings/masked-addresses-section.tsx): list, copy, describe,
// turn off, delete and create. Hidden until the server answers the first read
// with anything but "not available", since most servers (Stalwart Community)
// have none.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, View, Text, StyleSheet } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { EyeOff } from '../icons';
import Input from '../Input';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import {
  createMaskedEmailManager,
  maskedEmailErrorType,
  maskedEmailUnavailable,
  type MaskedAddress,
  type MaskedEmailManager,
} from '../../api/masked-email';

const PAGE_SIZE = 10;
const K = 'settings.security.masked_addresses';

type Status = 'loading' | 'ready' | 'forbidden' | 'unavailable' | 'error';

function statusOf(error: unknown): Status {
  if (maskedEmailUnavailable(error)) return 'unavailable';
  return maskedEmailErrorType(error) === 'forbidden' ? 'forbidden' : 'error';
}

function AddressRow({
  address, expanded, busy, canUpdate, canDelete, onExpand, onUpdate, onDelete,
}: {
  address: MaskedAddress;
  expanded: boolean;
  busy: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onExpand: () => void;
  onUpdate: (changes: { description?: string; enabled?: boolean }) => Promise<boolean>;
  onDelete: () => void;
}) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [description, setDescription] = useState(address.description ?? '');
  const [copyStatus, setCopyStatus] = useState<'copied' | 'copy_failed' | null>(null);
  useEffect(() => { setDescription(address.description ?? ''); }, [address.description, expanded]);

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(address.email);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('copy_failed');
    }
  };

  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.email} selectable>{address.email}</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {address.description || t(`${K}.no_description`, 'No description')}
            {' · '}
            {address.forDomain || t(`${K}.no_website`, 'Not specified')}
            {' · '}
            {address.enabled ? t(`${K}.enabled`, 'Enabled') : t(`${K}.disabled`, 'Disabled')}
          </Text>
        </View>
        <Button size="sm" variant="ghost" onPress={() => { void copy(); }} accessibilityLabel={`${t(`${K}.copy`, 'Copy')} ${address.email}`}>
          {t(`${K}.copy`, 'Copy')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onPress={onExpand}>
          {expanded ? t(`${K}.close`, 'Close') : t(`${K}.edit`, 'Edit')}
        </Button>
      </View>
      {copyStatus && (
        <Text style={styles.meta}>
          {copyStatus === 'copied'
            ? t(`${K}.copied`, 'Address copied.')
            : t(`${K}.copy_failed`, 'Could not copy. Select and copy the address above.')}
        </Text>
      )}
      {expanded && (
        <View style={styles.details}>
          <Input
            label={t(`${K}.description`, 'Description (optional)')}
            value={description}
            onChangeText={setDescription}
            editable={!busy && canUpdate}
          />
          <View style={styles.actions}>
            <Button
              size="sm"
              disabled={busy || !canUpdate || description === (address.description ?? '')}
              onPress={() => { void onUpdate({ description }); }}
            >
              {t(`${K}.save`, 'Save description')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !canUpdate} onPress={() => { void onUpdate({ enabled: !address.enabled }); }}>
              {address.enabled ? t(`${K}.disable`, 'Disable') : t(`${K}.enable`, 'Enable')}
            </Button>
            <Button size="sm" variant="destructive" disabled={busy || !canDelete} onPress={onDelete}>
              {t(`${K}.delete`, 'Delete')}
            </Button>
          </View>
        </View>
      )}
    </View>
  );
}

export function MaskedAddressesSection() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const manager = useMemo<MaskedEmailManager | null>(() => createMaskedEmailManager(), []);
  const [status, setStatus] = useState<Status>('loading');
  const [addresses, setAddresses] = useState<MaskedAddress[]>([]);
  // Shown once the first read answered anything but "not available".
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [canCreate, setCanCreate] = useState(true);
  const [canUpdate, setCanUpdate] = useState(true);
  const [canDelete, setCanDelete] = useState(true);
  const [deleteNeedsRefresh, setDeleteNeedsRefresh] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');

  const load = useCallback(async (): Promise<boolean> => {
    if (!manager) return false;
    try {
      const list = await manager.list();
      if (!manager.isCurrent()) return false;
      setAddresses(list);
      setStatus('ready');
      setShown(true);
      setPage((p) => Math.min(p, Math.max(0, Math.ceil(list.length / PAGE_SIZE) - 1)));
      setExpandedId((id) => (list.some((a) => a.id === id) ? id : null));
      setDeleteNeedsRefresh(false);
      return true;
    } catch (err) {
      if (!manager.isCurrent()) return false;
      setAddresses([]);
      setStatus(statusOf(err));
      if (!maskedEmailUnavailable(err)) setShown(true);
      return false;
    }
  }, [manager]);

  useEffect(() => { void load(); }, [load]);

  if (!manager || !shown) return null;

  const begin = () => {
    if (busyRef.current || !manager.isCurrent()) return false;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    return true;
  };
  const end = () => {
    busyRef.current = false;
    setBusy(false);
  };

  const noticeText = (key: string): string => {
    switch (key) {
      case 'saved': return t(`${K}.saved`, 'Change saved.');
      case 'deleted': return t(`${K}.deleted`, 'Address permanently deleted.');
      case 'deleted_refresh_failed': return t(`${K}.deleted_refresh_failed`, 'Deletion confirmed, but the list could not be refreshed. Refresh to load the current list.');
      case 'delete_forbidden': return t(`${K}.delete_forbidden`, 'Your current session is not allowed to delete masked addresses. Other permitted actions remain available.');
      case 'delete_unconfirmed': return t(`${K}.delete_unconfirmed`, 'Deletion could not be confirmed. It will not be retried. Refresh the list to check the address before any further deletion.');
      case 'delete_failed': return t(`${K}.delete_failed`, 'The address was not deleted. Refresh the list before trying again.');
      case 'create_forbidden': return t(`${K}.create_forbidden`, 'The server did not allow creating a masked address with this session.');
      case 'update_forbidden': return t(`${K}.update_forbidden`, 'The server did not allow editing masked addresses with this session. You can still copy addresses.');
      case 'over_quota': return t(`${K}.over_quota`, "The server's masked address quota has been reached. Disabled addresses may still count towards the limit.");
      case 'rate_limit': return t(`${K}.rate_limit`, "The server's creation rate limit has been reached. Try again later.");
      default: return t(`${K}.save_failed`, 'The change could not be confirmed. Refresh the list before trying again.');
    }
  };

  const mutate = async (kind: 'create' | 'update' | 'destroy', action: () => Promise<unknown>): Promise<boolean> => {
    if (!begin()) return false;
    try {
      await action();
    } catch (err) {
      const type = maskedEmailErrorType(err);
      if (type === 'forbidden') {
        if (kind === 'create') setCanCreate(false);
        else if (kind === 'update') setCanUpdate(false);
        else setCanDelete(false);
      }
      if (maskedEmailUnavailable(err)) { setAddresses([]); setStatus('unavailable'); }
      if (kind === 'destroy') {
        setDeleteNeedsRefresh(type !== 'forbidden');
        setNotice(type === 'forbidden' ? 'delete_forbidden' : type === 'deleteUnconfirmed' ? 'delete_unconfirmed' : 'delete_failed');
      } else {
        setNotice(type === 'forbidden' ? `${kind}_forbidden` : type === 'overQuota' ? 'over_quota' : type === 'rateLimit' ? 'rate_limit' : 'save_failed');
      }
      end();
      return false;
    }
    if (kind === 'create') { setDescription(''); setWebsite(''); }
    if (kind === 'destroy') setExpandedId(null);
    try {
      const loaded = await load();
      setNotice(kind === 'destroy' ? (loaded ? 'deleted' : 'deleted_refresh_failed') : 'saved');
      return true;
    } finally {
      end();
    }
  };

  const confirmDelete = (address: MaskedAddress) => {
    if (!canDelete || deleteNeedsRefresh || busyRef.current) return;
    Alert.alert(
      t(`${K}.delete_title`, 'Permanently delete masked address?'),
      t(`${K}.delete_warning`, 'Delete {address}? This cannot be undone. Mail sent to this address will no longer be delivered.', { address: address.email }),
      [
        { text: t(`${K}.cancel`, 'Cancel'), style: 'cancel' },
        {
          text: t(`${K}.delete_confirm`, 'Delete permanently'),
          style: 'destructive',
          onPress: () => { void mutate('destroy', () => manager.destroy(address.id)); },
        },
      ],
    );
  };

  const refresh = async () => {
    if (!begin()) return;
    try { await load(); } finally { end(); }
  };

  const pageCount = Math.max(1, Math.ceil(addresses.length / PAGE_SIZE));
  const visiblePage = Math.min(page, pageCount - 1);
  const onPage = addresses.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE);
  const statusText: Record<Exclude<Status, 'ready'>, string> = {
    loading: t(`${K}.loading`, 'Loading masked addresses…'),
    forbidden: t(`${K}.forbidden`, 'Your current session is not allowed to list masked addresses.'),
    unavailable: t(`${K}.unavailable`, "Masked addresses aren't available for this account or server."),
    error: t(`${K}.load_failed`, 'Could not load the complete address list. Refresh to try again.'),
  };

  return (
    <View style={{ gap: spacing.md }}>
      <View style={styles.headerRow}>
        <EyeOff size={16} color={c.mutedForeground} />
        <Text style={styles.headerTitle}>{t('settings.security.masked_addresses.title', 'Masked addresses')}</Text>
      </View>
      <Text style={styles.meta}>
        {t(`${K}.intro`, 'Receive mail without sharing your main address. Disabling an address rejects new mail to it. These addresses cannot be used to send mail.')}
      </Text>

      {status !== 'ready' && <Text style={styles.meta}>{statusText[status]}</Text>}

      {status === 'ready' && (
        <>
          {addresses.length === 0 ? (
            <Text style={styles.empty}>{t(`${K}.empty`, 'No masked addresses yet.')}</Text>
          ) : (
            <View style={{ gap: spacing.sm }}>
              {onPage.map((address) => (
                <AddressRow
                  key={address.id}
                  address={address}
                  expanded={expandedId === address.id}
                  busy={busy}
                  canUpdate={canUpdate}
                  canDelete={canDelete && !deleteNeedsRefresh}
                  onExpand={() => setExpandedId((id) => (id === address.id ? null : address.id))}
                  onUpdate={(changes) => mutate('update', () => manager.update(address.id, changes))}
                  onDelete={() => confirmDelete(address)}
                />
              ))}
              {pageCount > 1 && (
                <View style={styles.pager}>
                  <Button size="sm" variant="outline" disabled={busy || visiblePage === 0} onPress={() => { setPage(visiblePage - 1); setExpandedId(null); }}>
                    {t(`${K}.previous`, 'Previous')}
                  </Button>
                  <Text style={styles.meta}>{t(`${K}.page`, 'Page {page} of {pages}', { page: visiblePage + 1, pages: pageCount })}</Text>
                  <Button size="sm" variant="outline" disabled={busy || visiblePage === pageCount - 1} onPress={() => { setPage(visiblePage + 1); setExpandedId(null); }}>
                    {t(`${K}.next`, 'Next')}
                  </Button>
                </View>
              )}
            </View>
          )}
          {!canUpdate && <Text style={styles.meta}>{noticeText('update_forbidden')}</Text>}
          {!canDelete && <Text style={styles.meta}>{noticeText('delete_forbidden')}</Text>}

          <View style={styles.createBox}>
            <Text style={styles.subTitle}>{t(`${K}.create`, 'Create masked address')}</Text>
            <Input
              label={t(`${K}.website`, 'Website (optional)')}
              value={website}
              onChangeText={setWebsite}
              editable={!busy && canCreate}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              label={t(`${K}.description`, 'Description (optional)')}
              value={description}
              onChangeText={setDescription}
              editable={!busy && canCreate}
            />
            <View style={{ alignItems: 'flex-start' }}>
              <Button size="sm" disabled={busy || !canCreate} onPress={() => { void mutate('create', () => manager.create({ description, forDomain: website })); }}>
                {t(`${K}.create`, 'Create masked address')}
              </Button>
            </View>
            {!canCreate && <Text style={styles.meta}>{noticeText('create_forbidden')}</Text>}
          </View>
        </>
      )}

      {notice && <Text style={styles.meta}>{noticeText(notice)}</Text>}
      {status !== 'loading' && status !== 'unavailable' && (
        <View style={{ alignItems: 'flex-start' }}>
          <Button size="sm" variant="outline" disabled={busy} onPress={() => { void refresh(); }}>
            {t(`${K}.refresh`, 'Refresh')}
          </Button>
        </View>
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    headerTitle: { ...typography.bodyMedium, color: c.text },
    subTitle: { ...typography.bodyMedium, color: c.text },
    meta: { ...typography.caption, color: c.mutedForeground },
    empty: { ...typography.caption, color: c.mutedForeground, fontStyle: 'italic' },
    row: {
      gap: spacing.xs,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
    },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    email: { ...typography.bodyMedium, color: c.text },
    details: { gap: spacing.md, paddingTop: spacing.sm },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
    createBox: { gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: c.muted },
  });
}
