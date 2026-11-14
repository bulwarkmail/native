import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { RefreshCw } from '../icons';
import Button from '../Button';
import Input from '../Input';
import { SettingsKeyboardContext } from './keyboard-reveal';
import { SettingsSection } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { jmapClient } from '../../api/jmap-client';
import { useAuthStore } from '../../stores/auth-store';
import { useLocaleStore, type TranslateFn } from '../../stores/locale-store';
import { toast } from '../../stores/toast-store';
import { maskedEmailManagerForActiveLogin } from '../../api/masked-email';
import type { MaskedAddress, MaskedEmailManager } from '../../lib/masked-email';
import {
  MASKED_PAGE_SIZE,
  maskedFailureNotice,
  maskedLoadFailure,
  maskedPage,
  type MaskedChange,
  type MaskedLoadFailure,
  type MaskedNotice,
} from './masked-addresses';

// Ported from the webmail's components/settings/masked-addresses-section.tsx
// (#1534): the account's masked addresses on Stalwart, ten to a page. One
// can be copied, described, turned off (new mail to it is then rejected) or
// deleted for good, and a new one created. The section stays hidden until
// the server has answered the first read with anything but "not offered".

type Listing =
  | { status: 'loading' }
  | { status: MaskedLoadFailure }
  | { status: 'ready'; addresses: MaskedAddress[] };

// What the server refused this sign-in stays on screen next to the buttons it turned off.
const REFUSALS: MaskedNotice[] = ['create_forbidden', 'update_forbidden', 'delete_forbidden'];

function noticeText(t: TranslateFn, notice: MaskedNotice): string {
  switch (notice) {
    case 'saved': return t('settings.security.masked_addresses.saved', 'Change saved.');
    case 'deleted': return t('settings.security.masked_addresses.deleted', 'Address permanently deleted.');
    case 'deleted_refresh_failed': return t('settings.security.masked_addresses.deleted_refresh_failed', 'Deletion confirmed, but the list could not be refreshed. Refresh to load the current list.');
    case 'create_forbidden': return t('settings.security.masked_addresses.create_forbidden', 'The server did not allow creating a masked address with this session.');
    case 'update_forbidden': return t('settings.security.masked_addresses.update_forbidden', 'The server did not allow editing masked addresses with this session. You can still copy addresses.');
    case 'delete_forbidden': return t('settings.security.masked_addresses.delete_forbidden', 'Your current session is not allowed to delete masked addresses. Other permitted actions remain available.');
    case 'over_quota': return t('settings.security.masked_addresses.over_quota', "The server's masked address quota has been reached. Disabled addresses may still count towards the limit.");
    case 'rate_limit': return t('settings.security.masked_addresses.rate_limit', "The server's creation rate limit has been reached. Try again later.");
    case 'save_failed': return t('settings.security.masked_addresses.save_failed', 'The change could not be confirmed. Refresh the list before trying again.');
    case 'delete_unconfirmed': return t('settings.security.masked_addresses.delete_unconfirmed', 'Deletion could not be confirmed. It will not be retried. Refresh the list to check the address before any further deletion.');
    case 'delete_failed': return t('settings.security.masked_addresses.delete_failed', 'The address was not deleted. Refresh the list before trying again.');
  }
}

function loadFailureText(t: TranslateFn, failure: MaskedLoadFailure): string {
  switch (failure) {
    case 'forbidden': return t('settings.security.masked_addresses.forbidden', 'Your current session is not allowed to list masked addresses.');
    case 'unavailable': return t('settings.security.masked_addresses.unavailable', "Masked addresses aren't available for this account or server.");
    case 'error': return t('settings.security.masked_addresses.load_failed', 'Could not load the complete address list. Refresh to try again.');
  }
}

interface RowProps {
  address: MaskedAddress;
  expanded: boolean;
  busy: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onExpand: () => void;
  onUpdate: (id: string, changes: { description?: string; enabled?: boolean }) => void;
  onDelete: (address: MaskedAddress) => void;
}

function MaskedAddressRow({ address, expanded, busy, canUpdate, canDelete, onExpand, onUpdate, onDelete }: RowProps) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const revealOnKeyboard = React.useContext(SettingsKeyboardContext);
  const detailsRef = useRef<View>(null);
  const [description, setDescription] = useState(address.description ?? '');
  useEffect(() => {
    setDescription(address.description ?? '');
  }, [address.description, expanded]);
  const unchanged = description.trim() === (address.description ?? '');
  const save = () => {
    if (!busy && canUpdate && !unchanged) onUpdate(address.id, { description: description.trim() });
  };

  const copy = () => {
    Clipboard.setStringAsync(address.email).then(
      () => toast.success(t('settings.security.masked_addresses.copied', 'Address copied.')),
      () => toast.error(t('settings.security.masked_addresses.copy_failed', 'Could not copy. Select and copy the address above.')),
    );
  };
  const copyLabel = t('settings.security.masked_addresses.copy', 'Copy');
  const expandLabel = expanded
    ? t('settings.security.masked_addresses.close', 'Close')
    : t('settings.security.masked_addresses.edit', 'Edit');
  const switchLabel = address.enabled
    ? t('settings.security.masked_addresses.disable', 'Disable')
    : t('settings.security.masked_addresses.enable', 'Enable');
  const deleteLabel = t('settings.security.masked_addresses.delete', 'Delete');
  const descriptionLabel = t('settings.security.masked_addresses.description', 'Description (optional)');

  return (
    <View testID={`masked-address-${address.email}`}>
      <View style={styles.row}>
        <Text selectable style={styles.email}>{address.email}</Text>
        <Text style={styles.meta}>
          {address.description || t('settings.security.masked_addresses.no_description', 'No description')}
          {' · '}
          {/* The website is shown as text only, never opened. */}
          {address.forDomain || t('settings.security.masked_addresses.no_website', 'Not specified')}
        </Text>
        <View style={styles.rowFoot}>
          <Text style={[styles.state, !address.enabled && styles.stateOff]}>
            {address.enabled
              ? t('settings.security.masked_addresses.enabled', 'Enabled')
              : t('settings.security.masked_addresses.disabled', 'Disabled')}
          </Text>
          <View style={styles.buttons}>
            <Button variant="ghost" size="sm" onPress={copy} accessibilityLabel={`${copyLabel} ${address.email}`}>{copyLabel}</Button>
            <Button variant="outline" size="sm" onPress={onExpand} disabled={busy} accessibilityLabel={`${expandLabel} ${address.email}`}>
              {expandLabel}
            </Button>
          </View>
        </View>
      </View>
      {expanded && (
        <View ref={detailsRef} style={styles.details}>
          <Input
            label={descriptionLabel}
            accessibilityLabel={descriptionLabel}
            value={description}
            onChangeText={setDescription}
            editable={!busy && canUpdate}
            returnKeyType="done"
            onSubmitEditing={save}
            onFocus={() => revealOnKeyboard?.(detailsRef.current)}
          />
          <View style={styles.buttons}>
            <Button
              size="sm"
              disabled={busy || !canUpdate || unchanged}
              onPress={save}
            >
              {t('settings.security.masked_addresses.save', 'Save description')}
            </Button>
          </View>
          <View style={styles.detailsFoot}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !canUpdate}
              onPress={() => onUpdate(address.id, { enabled: !address.enabled })}
              accessibilityLabel={`${switchLabel} ${address.email}`}
            >
              {switchLabel}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy || !canDelete}
              onPress={() => onDelete(address)}
              accessibilityLabel={`${deleteLabel} ${address.email}`}
            >
              {deleteLabel}
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
  const session = useAuthStore((s) => s.session);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  // connectedAccountId, not accountId: the client is between sessions while
  // an account switch reconnects, and accountId throws then.
  const accountId = session ? jmapClient.connectedAccountId : null;
  const revealOnKeyboard = React.useContext(SettingsKeyboardContext);
  const formRef = useRef<View>(null);
  // The manager is bound to the login and account active when it is made;
  // another login or account gets a new one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const manager = useMemo(() => maskedEmailManagerForActiveLogin(), [activeAccountId, accountId]);
  // The manager the section shows now: answers to an earlier one are dropped.
  const latest = useRef(manager);

  const [view, setView] = useState<{ manager: MaskedEmailManager | null } & Listing>({ manager: null, status: 'loading' });
  // The manager whose server answered the first read with anything but "not offered".
  const [shownFor, setShownFor] = useState<MaskedEmailManager | null>(null);
  const [busy, setBusy] = useState<'refresh' | MaskedChange | null>(null);
  const operation = useRef<MaskedEmailManager | null>(null);
  const confirming = useRef<MaskedEmailManager | null>(null);
  const [canCreate, setCanCreate] = useState(true);
  const [canUpdate, setCanUpdate] = useState(true);
  const [canDelete, setCanDelete] = useState(true);
  const [deleteNeedsRefresh, setDeleteNeedsRefresh] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState<MaskedNotice | null>(null);
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');

  const load = useCallback(async (): Promise<MaskedAddress[] | null> => {
    if (!manager) return null;
    try {
      const addresses = await manager.list();
      if (latest.current !== manager || !manager.isCurrent()) return null;
      setView({ manager, status: 'ready', addresses });
      setShownFor(manager);
      setPage((previous) => maskedPage(addresses, previous).page);
      setExpandedId((previous) => (addresses.some((address) => address.id === previous) ? previous : null));
      setDeleteNeedsRefresh(false);
      return addresses;
    } catch (error) {
      if (latest.current === manager && manager.isCurrent()) {
        const failure = maskedLoadFailure(error);
        setView({ manager, status: failure });
        if (failure !== 'unavailable') setShownFor(manager);
      }
      return null;
    }
  }, [manager]);

  // Another account: nothing of the previous one stays, typed text included.
  useEffect(() => {
    latest.current = manager;
    operation.current = null;
    confirming.current = null;
    setView({ manager, status: 'loading' });
    setBusy(null);
    setCanCreate(true);
    setCanUpdate(true);
    setCanDelete(true);
    setDeleteNeedsRefresh(false);
    setExpandedId(null);
    setPage(0);
    setNotice(null);
    setDescription('');
    setWebsite('');
    void load();
  }, [manager, load]);

  if (!manager || shownFor !== manager) return null;
  // Still the manager on screen, for the login it was made for.
  const live = () => latest.current === manager && manager.isCurrent();
  const current: Listing = view.manager === manager ? view : { status: 'loading' };
  const addresses = current.status === 'ready' ? current.addresses : [];
  const shown = maskedPage(addresses, page);

  const begin = (kind: 'refresh' | MaskedChange) => {
    if (operation.current === manager || !live()) return false;
    operation.current = manager;
    setBusy(kind);
    setNotice(null);
    return true;
  };
  const end = () => {
    if (operation.current === manager) operation.current = null;
    if (live()) setBusy(null);
  };
  const say = (next: MaskedNotice, failed: boolean) => {
    setNotice(next);
    if (failed) toast.error(noticeText(t, next));
    else toast.success(noticeText(t, next));
  };

  const refresh = async () => {
    if (!begin('refresh')) return;
    try {
      await load();
    } finally {
      end();
    }
  };

  const change = async (kind: MaskedChange, action: () => Promise<unknown>) => {
    if (!begin(kind)) return;
    let created: unknown;
    try {
      created = await action();
    } catch (error) {
      if (live()) {
        const failure = maskedFailureNotice(kind, error);
        if (failure === 'create_forbidden') setCanCreate(false);
        if (failure === 'update_forbidden') setCanUpdate(false);
        if (failure === 'delete_forbidden') setCanDelete(false);
        if (maskedLoadFailure(error) === 'unavailable') setView({ manager, status: 'unavailable' });
        // A delete that failed any other way is asked again only after a fresh read.
        if (kind === 'destroy') setDeleteNeedsRefresh(failure !== 'delete_forbidden');
        say(failure, true);
      }
      end();
      return;
    }
    if (!live()) {
      end();
      return;
    }
    if (kind === 'create') {
      setDescription('');
      setWebsite('');
    }
    if (kind === 'destroy') setExpandedId(null);
    // Only a change the server confirmed is followed by a read.
    try {
      const loaded = await load();
      if (!live()) return;
      // Show the page the new address is on, wherever the server lists it.
      const index = kind === 'create' && loaded ? loaded.findIndex((address) => address.id === created) : -1;
      if (index >= 0) setPage(Math.floor(index / MASKED_PAGE_SIZE));
      if (kind !== 'destroy') say('saved', false);
      else if (loaded) say('deleted', false);
      else say('deleted_refresh_failed', true);
    } finally {
      end();
    }
  };

  const destroy = (address: MaskedAddress) => {
    if (!canDelete || deleteNeedsRefresh || operation.current === manager || confirming.current || !live()) return;
    confirming.current = manager;
    const answer = (accepted: boolean) => {
      // An answer to a dialog another account's section left open does nothing.
      if (confirming.current !== manager) return;
      confirming.current = null;
      if (accepted && live()) void change('destroy', () => manager.destroy(address.id));
    };
    Alert.alert(
      t('settings.security.masked_addresses.delete_title', 'Permanently delete masked address?'),
      t('settings.security.masked_addresses.delete_warning', 'Delete {address}? This cannot be undone. Mail sent to this address will no longer be delivered.', { address: address.email }),
      [
        { text: t('settings.security.masked_addresses.cancel', 'Cancel'), style: 'cancel', onPress: () => answer(false) },
        { text: t('settings.security.masked_addresses.delete_confirm', 'Delete permanently'), style: 'destructive', onPress: () => answer(true) },
      ],
      { cancelable: true, onDismiss: () => answer(false) },
    );
  };

  const changePage = (next: number) => {
    setPage(next);
    setExpandedId(null);
  };
  const websiteLabel = t('settings.security.masked_addresses.website', 'Website (optional)');
  const descriptionLabel = t('settings.security.masked_addresses.description', 'Description (optional)');
  const createLabel = t('settings.security.masked_addresses.create', 'Create masked address');
  const create = () => {
    if (!canCreate) return;
    void change('create', () => manager.create({ description: description.trim(), forDomain: website.trim() }));
  };

  return (
    <SettingsSection
      title={t('settings.security.masked_addresses.title', 'Masked addresses')}
      description={t('settings.security.masked_addresses.intro', 'Receive mail without sharing your main address. Disabling an address rejects new mail to it. These addresses cannot be used to send mail.')}
    >
      <View style={styles.body}>
        {current.status !== 'loading' && current.status !== 'ready' && (
          <Text style={styles.muted} accessibilityLiveRegion="polite">{loadFailureText(t, current.status)}</Text>
        )}

        {current.status === 'ready' && (
          <>
            <Text style={styles.small}>
              {t('settings.security.masked_addresses.count', '{count, plural, one {# address} other {# addresses}}', { count: addresses.length })}
            </Text>
            {addresses.length === 0 ? (
              <Text style={styles.muted}>{t('settings.security.masked_addresses.empty', 'No masked addresses yet.')}</Text>
            ) : (
              <View style={styles.list}>
                {shown.rows.map((address, index) => (
                  <View key={address.id} style={index > 0 && styles.rowBorder}>
                    <MaskedAddressRow
                      address={address}
                      expanded={expandedId === address.id}
                      busy={busy !== null}
                      canUpdate={canUpdate}
                      canDelete={canDelete && !deleteNeedsRefresh}
                      onExpand={() => setExpandedId((previous) => (previous === address.id ? null : address.id))}
                      onUpdate={(id, changes) => { void change('update', () => manager.update(id, changes)); }}
                      onDelete={destroy}
                    />
                  </View>
                ))}
              </View>
            )}
            {!canUpdate && <Text style={styles.muted}>{noticeText(t, 'update_forbidden')}</Text>}
            {!canDelete && <Text style={styles.muted}>{noticeText(t, 'delete_forbidden')}</Text>}
            {shown.pageCount > 1 && (
              <View style={styles.pager}>
                <Button variant="outline" size="sm" disabled={busy !== null || shown.page === 0} onPress={() => changePage(shown.page - 1)}>
                  {t('settings.security.masked_addresses.previous', 'Previous')}
                </Button>
                <Text style={styles.small}>
                  {t('settings.security.masked_addresses.page', 'Page {page} of {pages}', { page: shown.page + 1, pages: shown.pageCount })}
                </Text>
                <Button variant="outline" size="sm" disabled={busy !== null || shown.page === shown.pageCount - 1} onPress={() => changePage(shown.page + 1)}>
                  {t('settings.security.masked_addresses.next', 'Next')}
                </Button>
              </View>
            )}

            <View ref={formRef} style={styles.form}>
              <Text style={styles.formTitle}>{createLabel}</Text>
              <Input
                label={websiteLabel}
                accessibilityLabel={websiteLabel}
                testID="masked-address-website"
                value={website}
                onChangeText={setWebsite}
                editable={busy === null && canCreate}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="done"
                onSubmitEditing={create}
                onFocus={() => revealOnKeyboard?.(formRef.current)}
              />
              <Input
                label={descriptionLabel}
                accessibilityLabel={descriptionLabel}
                testID="masked-address-description"
                value={description}
                onChangeText={setDescription}
                editable={busy === null && canCreate}
                returnKeyType="done"
                onSubmitEditing={create}
                onFocus={() => revealOnKeyboard?.(formRef.current)}
              />
              <View style={styles.buttons}>
                <Button
                  size="sm"
                  loading={busy === 'create'}
                  disabled={busy !== null || !canCreate}
                  onPress={create}
                >
                  {createLabel}
                </Button>
              </View>
              {!canCreate && <Text style={styles.muted}>{noticeText(t, 'create_forbidden')}</Text>}
            </View>
          </>
        )}

        {/* The toast reads the notice out; this keeps it on screen. */}
        {notice && !REFUSALS.includes(notice) && <Text style={styles.muted}>{noticeText(t, notice)}</Text>}
        {current.status !== 'loading' && current.status !== 'unavailable' && (
          <View style={styles.buttons}>
            <Button
              variant="outline"
              size="sm"
              loading={busy === 'refresh'}
              disabled={busy !== null}
              onPress={() => { void refresh(); }}
              icon={<RefreshCw size={16} color={c.text} />}
            >
              {t('settings.security.masked_addresses.refresh', 'Refresh')}
            </Button>
          </View>
        )}
      </View>
    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    body: { gap: spacing.md },
    muted: { ...typography.body, color: c.textMuted },
    small: { ...typography.caption, color: c.textMuted },
    list: { borderWidth: 1, borderColor: c.border, borderRadius: radius.md, overflow: 'hidden' },
    rowBorder: { borderTopWidth: 1, borderTopColor: c.border },
    row: { gap: 2, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
    email: { ...typography.bodyMedium, color: c.text },
    meta: { ...typography.caption, color: c.textMuted },
    rowFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
    state: { ...typography.captionMedium, color: c.text },
    stateOff: { color: c.textMuted },
    buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    details: { gap: spacing.md, padding: spacing.md, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.muted },
    detailsFoot: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm },
    pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.sm },
    form: { gap: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: c.border },
    formTitle: { ...typography.bodyMedium, color: c.text },
  });
}
