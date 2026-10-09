import React from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, TextInput, Alert,
  KeyboardAvoidingView, Platform, Modal, Image, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import {
  ArrowLeft, Mail, Phone, Building, MapPin, Cake, Tag, FileText, User, Check, Calendar,
  Camera, X as XIcon, Globe, Heart, UserCircle, Plus, ChevronDown, ChevronRight, Book, Users,
} from 'lucide-react-native';
import type { RootStackParamList } from '../navigation/types';
import type { ContactCard } from '../api/types';
import { useContactsStore, selectGroupMembers } from '../stores/contacts-store';
import {
  getContactKeywords, getContactDisplayName, getContactPrimaryEmail,
  stringToPartialDate, isGroup,
} from '../lib/contact-utils';
import {
  canSaveContactForm, contactFormMissingState, contactFormPatchBase, contactFormSeed, formToPatch,
  shouldSeedContactForm, type FormState,
} from '../lib/contact-form-seed';
import { useNetworkStore } from '../stores/network-store';
import { jmapClient } from '../api/jmap-client';
import { isShownAccount, requireShownAccountScope, useEmailStore } from '../stores/email-store';
import Dialog from '../components/Dialog';
import ContactPickerSheet from '../components/contacts/ContactPickerSheet';
import { spacing, radius, typography, componentSizes, fontPx, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useLocaleStore, type TranslateFn } from '../stores/locale-store';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ContactForm'>;
type Route = RouteProp<RootStackParamList, 'ContactForm'>;

type Option = { value: string; label: string };

function formOptions(t: TranslateFn) {
  const contexts: Option[] = [
    { value: '', label: t('contacts.form.context_none', 'None') },
    { value: 'work', label: t('contacts.form.context_work', 'Work') },
    { value: 'private', label: t('contacts.form.context_private', 'Private') },
  ];
  const phoneFeatures: Option[] = [
    { value: '', label: t('contacts.form.phone', 'Phone') },
    { value: 'voice', label: t('contacts.form.phone_voice', 'Voice') },
    { value: 'cell', label: t('contacts.form.phone_cell', 'Mobile') },
    { value: 'fax', label: t('contacts.form.phone_fax', 'Fax') },
    { value: 'pager', label: t('contacts.form.phone_pager', 'Pager') },
    { value: 'video', label: t('contacts.form.phone_video', 'Video') },
    { value: 'text', label: t('contacts.form.phone_text', 'Text') },
  ];
  const anniversaryKinds: Option[] = [
    { value: 'birth', label: t('contacts.form.anniversary_birth', 'Birthday') },
    { value: 'wedding', label: t('contacts.form.anniversary_wedding', 'Anniversary') },
    { value: 'death', label: t('contacts.form.anniversary_death', 'Memorial') },
    { value: 'other', label: t('contacts.form.anniversary_other', 'Other') },
  ];
  const personalInfoKinds: Option[] = [
    { value: 'hobby', label: t('contacts.form.personal_hobby', 'Hobby') },
    { value: 'expertise', label: t('contacts.form.personal_expertise', 'Expertise') },
    { value: 'interest', label: t('contacts.form.personal_interest', 'Interest') },
    { value: 'other', label: t('contacts.form.personal_other', 'Other') },
  ];
  const personalInfoLevels: Option[] = [
    { value: '', label: '–' },
    { value: 'low', label: t('contacts.form.level_low', 'Low') },
    { value: 'medium', label: t('contacts.form.level_medium', 'Medium') },
    { value: 'high', label: t('contacts.form.level_high', 'High') },
  ];
  // Same vocabulary as the webmail form and the vCard SEX mapping
  // (M/F/O/N/U), so a card renders the same value in both apps.
  const gender: Option[] = [
    { value: '', label: t('contacts.form.gender_unspecified', 'Unspecified') },
    { value: 'masculine', label: t('contacts.form.gender_male', 'Male') },
    { value: 'feminine', label: t('contacts.form.gender_female', 'Female') },
    { value: 'other', label: t('contacts.form.gender_other', 'Other') },
    { value: 'none', label: t('contacts.form.gender_none', 'Not applicable') },
    { value: 'unknown', label: t('contacts.form.gender_unknown', 'Unknown') },
  ];
  const kind: Option[] = [
    { value: 'person', label: t('contacts.form.type_person', 'Person') },
    { value: 'org', label: t('contacts.form.type_organization', 'Organization') },
  ];
  return { contexts, phoneFeatures, anniversaryKinds, personalInfoKinds, personalInfoLevels, gender, kind };
}

const MAX_PHOTO_DIM = 512;
const PHOTO_QUALITY = 0.85;

/**
 * Downscale a picked image to at most 512px and embed it as a JPEG data URI
 * (the webmail's processImageFile). Falls back to the picker's own base64
 * when the manipulator is unavailable.
 */
async function processPickedImage(asset: ImagePicker.ImagePickerAsset): Promise<{ uri: string; mediaType: string }> {
  try {
    const width = asset.width || 0;
    const height = asset.height || 0;
    const longest = Math.max(width, height);
    const actions: ImageManipulator.Action[] = [];
    if (longest > MAX_PHOTO_DIM) {
      actions.push({ resize: width >= height ? { width: MAX_PHOTO_DIM } : { height: MAX_PHOTO_DIM } });
    } else if (!longest) {
      actions.push({ resize: { width: MAX_PHOTO_DIM } });
    }
    const result = await ImageManipulator.manipulateAsync(asset.uri, actions, {
      compress: PHOTO_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    if (result.base64) {
      return { uri: `data:image/jpeg;base64,${result.base64}`, mediaType: 'image/jpeg' };
    }
  } catch (err) {
    console.warn('[contact-form] photo downscale failed, using original', err);
  }
  const mime = asset.mimeType || 'image/jpeg';
  if (asset.base64) return { uri: `data:${mime};base64,${asset.base64}`, mediaType: mime };
  return { uri: asset.uri, mediaType: mime };
}

function Pills({
  value, options, onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.pillRow}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={[styles.pill, active && styles.pillActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.pillText, active && styles.pillTextActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Section({
  icon, label, children,
  collapsible = false, defaultOpen = true,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [open, setOpen] = React.useState(defaultOpen);
  const isOpen = collapsible ? open : true;

  return (
    <View style={styles.section}>
      <Pressable
        onPress={() => collapsible && setOpen((o) => !o)}
        style={styles.sectionHeader}
        disabled={!collapsible}
        accessibilityRole={collapsible ? 'button' : 'header'}
        accessibilityState={collapsible ? { expanded: isOpen } : undefined}
      >
        <View style={styles.sectionIcon}>{icon}</View>
        <Text style={styles.sectionLabel}>{label}</Text>
        {collapsible && (
          isOpen
            ? <ChevronDown size={14} color={c.textMuted} />
            : <ChevronRight size={14} color={c.textMuted} />
        )}
      </Pressable>
      {isOpen && <View style={styles.sectionBody}>{children}</View>}
    </View>
  );
}

function Field({ label, children }: { label?: string; children: React.ReactNode }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.field}>
      {!!label && <Text style={styles.fieldLabel}>{label}</Text>}
      {children}
    </View>
  );
}

function RemovableRow({
  onRemove, children,
}: {
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  return (
    <View style={styles.removableRow}>
      <View style={{ flex: 1 }}>{children}</View>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        style={styles.removeBtn}
        accessibilityRole="button"
        accessibilityLabel={t('common.remove', 'Remove')}
      >
        <XIcon size={14} color={c.textMuted} />
      </Pressable>
    </View>
  );
}

function AddButton({ onPress, label }: { onPress: () => void; label: string }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.addBtn, pressed && styles.addBtnPressed]}
      accessibilityRole="button"
    >
      <Plus size={14} color={c.primary} />
      <Text style={styles.addBtnLabel}>{label}</Text>
    </Pressable>
  );
}

export default function ContactFormScreen() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const t = useLocaleStore((s) => s.t);
  const opts = React.useMemo(() => formOptions(t), [t]);
  const { contactId, addressBookId: initialBook, asGroup: asGroupParam, prefill, memberIds: initialMemberIds } = route.params || {};
  const isEdit = !!contactId;

  const addressBooks = useContactsStore((s) => s.addressBooks);
  const allContacts = useContactsStore((s) => s.contacts);
  const createContact = useContactsStore((s) => s.createContact);
  const updateContact = useContactsStore((s) => s.updateContact);
  const getDefaultAddressBookId = useContactsStore((s) => s.getDefaultAddressBookId);
  // Set once cards were read from the server (null for the persisted cache,
  // which keeps no photos, and after a reset).
  const liveCards = useContactsStore((s) => s.contactsGen !== null);
  // The account this form edits or creates in. Card ids repeat across
  // accounts, so a save after a switch would land on the other account's
  // card with the same id (or in its books): refused instead.
  const [formAccountId] = React.useState(() => useEmailStore.getState().activeAccountId);
  const shownAccountId = useEmailStore((s) => s.activeAccountId);
  const formAccountShown = !!formAccountId && shownAccountId === formAccountId;
  // The card being edited, only from a live load: one from the cache would
  // seed the form without its photo, or with values the server has replaced.
  // None while another account is shown: the store holds its cards then.
  const existing = React.useMemo(
    () => (contactId && liveCards && formAccountShown ? allContacts.find((c) => c.id === contactId) : undefined),
    [allContacts, contactId, liveCards, formAccountShown],
  );
  // A card gets the form of its kind whichever way it was opened (a link
  // names only the id): the person form would save a group without its
  // members, the group form a person without their details.
  const asGroup = existing ? isGroup(existing) : !!asGroupParam;
  const existingKeywords = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const contact of allContacts) {
      for (const kw of getContactKeywords(contact)) {
        counts.set(kw, (counts.get(kw) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([keyword, count]) => ({ keyword, count }))
      .sort((a, b) => a.keyword.localeCompare(b.keyword));
  }, [allContacts]);

  const seedFor = (card: typeof existing): FormState => contactFormSeed(card, prefill, {
    addressBookId: initialBook || getDefaultAddressBookId() || '',
    memberIds: card
      ? asGroup ? selectGroupMembers({ contacts: allContacts }, card.id).map((m) => m.id) : []
      : initialMemberIds ?? [],
  });
  const [form, setForm] = React.useState<FormState>(() => seedFor(existing));
  // The card the form shows, and what an edit's patch is relative to (see
  // `contactFormPatchBase`). An edit opened before its card loaded starts
  // blank and cannot save until it is seeded from the card.
  const [seededFrom, setSeededFrom] = React.useState(existing);
  // The account `seededFrom` came from (see `shouldSeedContactForm`).
  const [seededAccountId, setSeededAccountId] = React.useState(formAccountId);
  const seedAccounts = { formAccount: formAccountId, shownAccount: shownAccountId, seededAccount: seededAccountId };
  const [keywordInput, setKeywordInput] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(!!prefill || !!initialMemberIds?.length);
  // An edit whose card is not in the store asks for the contacts, and says
  // why it cannot show it once that load is over.
  const [lookedUp, setLookedUp] = React.useState(false);
  // How the last lookup ended, and how many retries were asked for.
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [connected, setConnected] = React.useState(true);
  const [lookupAttempt, setLookupAttempt] = React.useState(0);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [datePickerIndex, setDatePickerIndex] = React.useState<number | null>(null);
  const [memberPickerOpen, setMemberPickerOpen] = React.useState(false);

  // Seeded during render, so no frame ever shows (or saves) a form that
  // does not match `seededFrom`: React re-renders before committing.
  if (shouldSeedContactForm({ seededFrom, existing, dirty, ...seedAccounts })) {
    setSeededFrom(existing);
    setSeededAccountId(shownAccountId);
    setForm(seedFor(existing));
  }

  // Looked up only while the form's account is shown: a load now would be
  // another account's contacts.
  const awaitingCard = isEdit && !existing && formAccountShown;
  const online = useNetworkStore((s) => s.online);
  React.useEffect(() => {
    // Look again should the card go (a reset) and not come back.
    if (!awaitingCard) {
      setLookedUp(false);
      return;
    }
    if (lookedUp) return;
    let active = true;
    // A retry loads again even when the last load is recent: it failed, or
    // ran before the card existed.
    const contacts = useContactsStore.getState();
    const load = lookupAttempt === 0 ? contacts.fetchContactsIfStale() : contacts.fetchContacts();
    void load.finally(() => {
      if (!active) return;
      setLoadFailed(!!useContactsStore.getState().error);
      setConnected(jmapClient.isConnected);
      setLookedUp(true);
    });
    return () => { active = false; };
  }, [awaitingCard, lookedUp, lookupAttempt]);
  const retryLookup = React.useCallback(() => {
    setLookupAttempt((n) => n + 1);
    setLookedUp(false);
  }, []);
  const missingState = contactFormMissingState({
    formAccountShown, lookedUp, liveCards, online, connected, loadFailed,
  });
  // Back online after a lookup that needed a connection: look again.
  const wasOnline = React.useRef(online);
  React.useEffect(() => {
    const cameBack = online && !wasOnline.current;
    wasOnline.current = online;
    if (cameBack && awaitingCard && lookedUp && !liveCards) retryLookup();
  }, [online, awaitingCard, lookedUp, liveCards, retryLookup]);

  React.useEffect(() => {
    if (!form.addressBookId) {
      const fallback = getDefaultAddressBookId();
      if (fallback) setForm((f) => ({ ...f, addressBookId: fallback }));
    }
  }, [addressBooks, form.addressBookId, getDefaultAddressBookId]);

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const handleBack = () => {
    if (dirty) setConfirmDiscard(true);
    else navigation.goBack();
  };

  const handleSave = async () => {
    // Never patch (or create in place of) a card the form does not show.
    if (!canSaveContactForm({ isEdit, existing, seededFrom, ...seedAccounts })) return;
    const orgName = form.orgs[0]?.name.trim() || '';
    if (asGroup) {
      if (!form.given.trim()) {
        Alert.alert(
          t('contacts.form.missing_info', 'Missing info'),
          t('contacts.groups.name_required', 'Group name is required'),
        );
        return;
      }
    } else if (form.isOrg) {
      if (!orgName) {
        Alert.alert(
          t('contacts.form.missing_info', 'Missing info'),
          t('contacts.form.org_name_required', 'Add the organization name.'),
        );
        return;
      }
    } else {
      const hasName = form.given.trim() || form.surname.trim() || form.full.trim();
      const hasEmail = form.emails.some((e) => e.address.trim());
      // An organization name identifies the card just as well as a personal name.
      if (!hasName && !hasEmail && !orgName) {
        Alert.alert(
          t('contacts.form.missing_info', 'Missing info'),
          t('contacts.form.name_or_email_required', 'Add a name or at least one email.'),
        );
        return;
      }
    }
    if (!form.addressBookId) {
      Alert.alert(
        t('contacts.form.missing_address_book', 'Missing address book'),
        t('contacts.form.address_book_required', 'Select an address book to save this contact.'),
      );
      return;
    }
    // Email validity
    for (const e of form.emails) {
      if (e.address.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.address.trim())) {
        Alert.alert(
          t('contacts.form.invalid_email_title', 'Invalid email'),
          t('contacts.form.invalid_email_message', '"{address}" is not a valid email address.', { address: e.address }),
        );
        return;
      }
    }
    // Dates must be structured (RFC 9553 PartialDate) - the server rejects
    // free text, and a rejected date used to take the whole card with it.
    for (const a of form.anniversaries) {
      if (a.date.trim() && !stringToPartialDate(a.date)) {
        Alert.alert(
          t('contacts.form.invalid_date_title', 'Invalid date'),
          t(
            'contacts.form.invalid_date_message',
            '"{date}" is not a date. Use YYYY-MM-DD, YYYY-MM, YYYY or --MM-DD.',
            { date: a.date },
          ),
        );
        return;
      }
    }
    setSaving(true);
    try {
      // Bound to the connection serving the form's account, so the write is
      // refused once another one replaced it.
      const at = requireShownAccountScope(formAccountId);
      const patch = formToPatch(form, contactFormPatchBase({ isEdit, seededFrom }), asGroup, allContacts);
      // Past `canSaveContactForm`, an edit always has its card here.
      if (existing) {
        await updateContact(existing.id, patch, at);
        navigation.goBack();
      } else {
        const created = await createContact(patch, form.addressBookId, at);
        // Switched meanwhile: the new card's id would open the other
        // account's card with that id.
        if (!isShownAccount(formAccountId)) {
          navigation.goBack();
          return;
        }
        if (asGroup) navigation.replace('GroupDetail', { groupId: created.id });
        else navigation.replace('ContactDetail', { contactId: created.id });
      }
    } catch (err) {
      Alert.alert(
        asGroup
          ? t('contacts.groups.save_failed', 'Failed to save group')
          : t('contacts.form.save_failed', 'Failed to save contact'),
        err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'),
      );
    } finally {
      setSaving(false);
    }
  };

  const existingName = existing ? getContactDisplayName(existing) : '';
  const headerTitle = isEdit
    ? existingName
      ? t('contacts.form.edit_named', 'Edit {name}', { name: existingName })
      : asGroup ? t('contacts.groups.edit', 'Edit Group') : t('contacts.form.edit_title', 'Edit Contact')
    : asGroup ? t('contacts.groups.create', 'New Group') : t('contacts.form.create_title', 'New Contact');

  const previewName = form.isOrg
    ? (form.orgs[0]?.name || '').trim()
    : [form.given, form.surname].filter(Boolean).join(' ').trim() || form.full.trim();

  const pickPhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t('contacts.form.photo_permission_title', 'Photo access needed'),
        t('contacts.form.photo_permission_message', 'Grant photo library permission to pick a contact photo.'),
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    if (result.canceled || !result.assets[0]) return;
    const { uri, mediaType } = await processPickedImage(result.assets[0]);
    setDirty(true);
    setForm((f) => ({ ...f, photoUri: uri, photoMediaType: mediaType }));
  };

  const memberContacts = React.useMemo(
    () => form.members
      .map((id) => allContacts.find((c) => c.id === id))
      .filter((m): m is ContactCard => !!m),
    [form.members, allContacts],
  );
  const memberIdSet = React.useMemo(() => new Set(form.members), [form.members]);

  const addressBookSection = addressBooks.length > 1 && (
    <Section icon={<Book size={16} color={c.textMuted} />} label={t('contacts.address_books.address_book', 'Address Book')}>
      <View style={styles.pillRow}>
        {addressBooks.filter((b) => b.myRights?.mayWrite !== false || b.id === form.addressBookId).map((book) => (
          <Pressable
            key={book.id}
            onPress={() => updateForm('addressBookId', book.id)}
            style={[styles.pill, form.addressBookId === book.id && styles.pillActive]}
          >
            <Text style={[styles.pillText, form.addressBookId === book.id && styles.pillTextActive]}>
              {book.isShared && book.accountName ? `${book.name} (${book.accountName})` : book.name}
            </Text>
          </Pressable>
        ))}
      </View>
    </Section>
  );

  const notesSection = (
    <Section
      icon={<FileText size={16} color={c.textMuted} />}
      label={t('contacts.form.note', 'Notes')}
      collapsible
      defaultOpen={form.notes.length > 0}
    >
      {form.notes.map((n, i) => (
        <RemovableRow
          key={i}
          onRemove={() => updateForm('notes', form.notes.filter((_, idx) => idx !== i))}
        >
          <TextInput
            style={[styles.input, styles.multiline]}
            placeholder={t('contacts.form.note_placeholder', 'Add a note...')}
            placeholderTextColor={c.textMuted}
            multiline
            value={n.note}
            onChangeText={(v) => {
              const next = [...form.notes];
              next[i] = { note: v };
              updateForm('notes', next);
            }}
          />
        </RemovableRow>
      ))}
      <AddButton
        label={t('contacts.form.add_note', 'Add note')}
        onPress={() => updateForm('notes', [...form.notes, { note: '' }])}
      />
    </Section>
  );

  const categoriesSection = (
    <Section
      icon={<Tag size={16} color={c.textMuted} />}
      label={t('contacts.form.categories', 'Categories')}
      collapsible
      defaultOpen={form.keywords.length > 0}
    >
      {form.keywords.length > 0 && (
        <View style={styles.chipRow}>
          {form.keywords.map((kw) => (
            <Pressable
              key={kw}
              onPress={() => updateForm('keywords', form.keywords.filter((k) => k !== kw))}
              style={styles.keywordChip}
            >
              <Text style={styles.keywordChipText}>{kw}</Text>
              <XIcon size={11} color={c.primary} />
            </Pressable>
          ))}
        </View>
      )}
      <TextInput
        style={styles.input}
        placeholder={t('contacts.form.categories_placeholder_mobile', 'Add tag and press Enter')}
        placeholderTextColor={c.textMuted}
        value={keywordInput}
        onChangeText={setKeywordInput}
        onSubmitEditing={() => {
          const k = keywordInput.trim();
          if (k && !form.keywords.includes(k)) {
            updateForm('keywords', [...form.keywords, k]);
          }
          setKeywordInput('');
        }}
        returnKeyType="done"
      />
      {existingKeywords.length > 0 && (
        <View style={styles.chipRow}>
          {existingKeywords
            .filter((k) => !form.keywords.includes(k.keyword))
            .slice(0, 8)
            .map((k) => (
              <Pressable
                key={k.keyword}
                onPress={() => updateForm('keywords', [...form.keywords, k.keyword])}
                style={styles.suggestedChip}
              >
                <Text style={styles.suggestedChipText}>+ {k.keyword}</Text>
              </Pressable>
            ))}
        </View>
      )}
    </Section>
  );

  const header = (
    <View style={styles.header}>
      <Pressable
        onPress={handleBack}
        style={styles.headerBtn}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('common.back', 'Back')}
      >
        <ArrowLeft size={22} color={c.text} />
      </Pressable>
      <Text style={styles.headerTitle} numberOfLines={1}>{headerTitle}</Text>
      <Pressable
        onPress={handleSave}
        disabled={saving}
        style={styles.saveBtn}
        hitSlop={8}
        accessibilityRole="button"
      >
        {saving ? (
          <Text style={styles.saveLabel}>
            {isEdit ? t('contacts.form.updating', 'Updating...') : t('contacts.form.creating', 'Creating...')}
          </Text>
        ) : (
          <>
            <Check size={16} color={c.primaryForeground} />
            <Text style={styles.saveLabel}>{t('contacts.form.save', 'Save')}</Text>
          </>
        )}
      </Pressable>
    </View>
  );

  const discardDialog = (
    <Dialog
      visible={confirmDiscard}
      title={t('settings.discard_changes', 'Discard unsaved changes?')}
      message={t('settings.unsaved_changes', 'You have unsaved changes')}
      variant="destructive"
      confirmText={t('settings.discard', 'Discard')}
      onConfirm={() => {
        setConfirmDiscard(false);
        navigation.goBack();
      }}
      onCancel={() => setConfirmDiscard(false)}
    />
  );

  if (!canSaveContactForm({ isEdit, existing, seededFrom, ...seedAccounts })) {
    // No card yet: neither fields nor Save, so a blank form can never be
    // saved over it.
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <Pressable
            onPress={() => navigation.goBack()}
            style={styles.headerBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', 'Back')}
          >
            <ArrowLeft size={22} color={c.text} />
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>{headerTitle}</Text>
        </View>
        <View style={styles.missing}>
          {missingState === 'loading' ? (
            <ActivityIndicator color={c.primary} accessibilityLabel={t('common.loading', 'Loading...')} />
          ) : (
            <>
              <Text style={styles.missingText}>
                {missingState === 'switched'
                  ? t('email_list.account_switched_back', 'This belongs to another account. Switch back to it and try again.')
                  : missingState === 'not_found'
                    ? t('contacts.detail.not_found', 'Contact not found')
                    : missingState === 'load_failed'
                      ? t('contacts.form.edit_load_failed', "Couldn't load this contact")
                      // Only the cache so far: it keeps no photos, so an
                      // edit from it would clear the photo.
                      : t('contacts.form.edit_needs_connection', 'Editing a contact needs a connection')}
              </Text>
              {missingState !== 'switched' && (
                <Pressable
                  onPress={retryLookup}
                  style={({ pressed }) => [styles.addBtn, pressed && styles.addBtnPressed]}
                  accessibilityRole="button"
                >
                  <Text style={styles.addBtnLabel}>{t('errors.retry', 'Retry')}</Text>
                </Pressable>
              )}
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  if (asGroup) {
    // Groups are a name plus a member list - none of the person fields apply.
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        {header}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            {addressBookSection}

            <Section icon={<Users size={16} color={c.textMuted} />} label={t('contacts.group', 'Group')}>
              <Field label={t('contacts.groups.name_label', 'Group Name')}>
                <TextInput
                  style={styles.input}
                  placeholder={t('contacts.groups.name_placeholder', 'e.g., Team, Family')}
                  placeholderTextColor={c.textMuted}
                  value={form.given}
                  onChangeText={(v) => updateForm('given', v)}
                  autoFocus={!isEdit}
                />
              </Field>
            </Section>

            <Section icon={<User size={16} color={c.textMuted} />} label={t('contacts.groups.members_with_count', 'Members ({count})', { count: memberContacts.length })}>
              {memberContacts.map((m) => {
                const email = getContactPrimaryEmail(m);
                return (
                  <RemovableRow
                    key={m.id}
                    onRemove={() => updateForm('members', form.members.filter((id) => id !== m.id))}
                  >
                    <Text style={styles.memberName} numberOfLines={1}>{getContactDisplayName(m) || t('contacts.unnamed', 'Unnamed')}</Text>
                    {!!email && <Text style={styles.memberEmail} numberOfLines={1}>{email}</Text>}
                  </RemovableRow>
                );
              })}
              <AddButton label={t('contacts.groups.add_members', 'Add members')} onPress={() => setMemberPickerOpen(true)} />
            </Section>

            {categoriesSection}
            {notesSection}
          </ScrollView>
        </KeyboardAvoidingView>

        <ContactPickerSheet
          visible={memberPickerOpen}
          onClose={() => setMemberPickerOpen(false)}
          title={t('contacts.groups.add_members', 'Add members')}
          excludedIds={memberIdSet}
          onSelect={(ids) => {
            setMemberPickerOpen(false);
            const merged = [...form.members];
            for (const id of ids) if (!merged.includes(id)) merged.push(id);
            updateForm('members', merged);
          }}
        />
        {discardDialog}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {header}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {/* Photo + Name preview */}
          <View style={styles.photoPanel}>
            <Pressable
              onPress={() => { void pickPhoto(); }}
              style={styles.photoBtn}
              accessibilityRole="button"
              accessibilityLabel={t('contacts.form.upload_photo', 'Upload photo')}
            >
              {form.photoUri ? (
                <Image source={{ uri: form.photoUri }} style={styles.photoThumb} />
              ) : (
                <View style={[styles.photoThumb, styles.photoPlaceholder]}>
                  <Camera size={28} color={c.textMuted} />
                </View>
              )}
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={styles.previewName} numberOfLines={1}>
                {previewName || (form.isOrg
                  ? t('contacts.form.new_organization', 'New organization')
                  : t('contacts.create_new', 'New Contact'))}
              </Text>
              <Text style={styles.previewHint}>{t('contacts.form.photo_hint_mobile', 'Tap photo to choose an image')}</Text>
              {form.photoUri ? (
                <Pressable
                  onPress={() => {
                    updateForm('photoUri', '');
                    updateForm('photoMediaType', '');
                  }}
                  style={styles.removePhotoBtn}
                  hitSlop={8}
                  accessibilityRole="button"
                >
                  <Text style={styles.removePhotoLabel}>{t('contacts.form.remove_photo', 'Remove photo')}</Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          {addressBookSection}

          {/* Identity */}
          <Section icon={<User size={16} color={c.textMuted} />} label={t('contacts.form.section_identity', 'Name & Identity')}>
            <Pills
              value={form.isOrg ? 'org' : 'person'}
              options={opts.kind}
              onChange={(v) => {
                const isOrg = v === 'org';
                setDirty(true);
                setForm((f) => ({
                  ...f,
                  isOrg,
                  // An organization card needs a place to type its name.
                  orgs: isOrg && f.orgs.length === 0
                    ? [{ name: '', department: '', jobTitle: '', role: '' }]
                    : f.orgs,
                }));
              }}
            />
            {form.isOrg ? (
              <Field label={t('contacts.form.organization', 'Organization')}>
                <TextInput
                  style={styles.input}
                  placeholder={t('contacts.form.organization_placeholder', 'Company name')}
                  placeholderTextColor={c.textMuted}
                  value={form.orgs[0]?.name || ''}
                  onChangeText={(v) => {
                    const next = form.orgs.length > 0 ? [...form.orgs] : [{ name: '', department: '', jobTitle: '', role: '' }];
                    next[0] = { ...next[0], name: v };
                    updateForm('orgs', next);
                  }}
                />
              </Field>
            ) : (
              <>
                <View style={styles.row2}>
                  <Field label={t('contacts.form.prefix', 'Prefix')}>
                    <TextInput
                      style={styles.input}
                      placeholder={t('contacts.form.prefix_placeholder', 'Dr., Mr., Mrs.')}
                      placeholderTextColor={c.textMuted}
                      value={form.prefix}
                      onChangeText={(v) => updateForm('prefix', v)}
                    />
                  </Field>
                  <Field label={t('contacts.form.suffix', 'Suffix')}>
                    <TextInput
                      style={styles.input}
                      placeholder={t('contacts.form.suffix_placeholder', 'Jr., Sr., III')}
                      placeholderTextColor={c.textMuted}
                      value={form.suffix}
                      onChangeText={(v) => updateForm('suffix', v)}
                    />
                  </Field>
                </View>
                <Field label={t('contacts.form.given_name', 'First name')}>
                  <TextInput
                    style={styles.input}
                    placeholder={t('contacts.form.given_name', 'First name')}
                    placeholderTextColor={c.textMuted}
                    value={form.given}
                    onChangeText={(v) => updateForm('given', v)}
                  />
                </Field>
                <Field label={t('contacts.form.middle_name', 'Middle name')}>
                  <TextInput
                    style={styles.input}
                    placeholder={t('contacts.form.middle_name', 'Middle name')}
                    placeholderTextColor={c.textMuted}
                    value={form.middle}
                    onChangeText={(v) => updateForm('middle', v)}
                  />
                </Field>
                <Field label={t('contacts.form.surname', 'Last name')}>
                  <TextInput
                    style={styles.input}
                    placeholder={t('contacts.form.surname', 'Last name')}
                    placeholderTextColor={c.textMuted}
                    value={form.surname}
                    onChangeText={(v) => updateForm('surname', v)}
                  />
                </Field>
                {form.nicknames.map((nick, i) => (
                  <Field key={i} label={i === 0 ? t('contacts.form.nickname', 'Nickname') : undefined}>
                    <View style={styles.dateInputRow}>
                      <TextInput
                        style={[styles.input, { flex: 1 }]}
                        placeholder={t('contacts.form.nickname_placeholder', 'Nickname')}
                        placeholderTextColor={c.textMuted}
                        value={nick}
                        onChangeText={(v) => {
                          const next = [...form.nicknames];
                          next[i] = v;
                          updateForm('nicknames', next);
                        }}
                      />
                      {form.nicknames.length > 1 && (
                        <Pressable
                          onPress={() => updateForm('nicknames', form.nicknames.filter((_, idx) => idx !== i))}
                          hitSlop={8}
                          style={styles.removeBtn}
                          accessibilityRole="button"
                          accessibilityLabel={t('common.remove', 'Remove')}
                        >
                          <XIcon size={14} color={c.textMuted} />
                        </Pressable>
                      )}
                    </View>
                  </Field>
                ))}
                {form.nicknames.every((n) => n.trim()) && (
                  <AddButton label={t('contacts.form.add_nickname', 'Add nickname')} onPress={() => updateForm('nicknames', [...form.nicknames, ''])} />
                )}
              </>
            )}
            <Field label={t('contacts.form.display_name_optional', 'Display name (optional)')}>
              <TextInput
                style={styles.input}
                placeholder={t('contacts.form.display_name_placeholder', 'Custom display name')}
                placeholderTextColor={c.textMuted}
                value={form.full}
                onChangeText={(v) => updateForm('full', v)}
              />
            </Field>
          </Section>

          {/* Email */}
          <Section icon={<Mail size={16} color={c.textMuted} />} label={t('contacts.form.email', 'Email')}>
            {form.emails.map((e, i) => (
              <RemovableRow
                key={i}
                onRemove={() => updateForm('emails', form.emails.filter((_, idx) => idx !== i))}
              >
                <TextInput
                  style={styles.input}
                  placeholder={t('contacts.form.email_placeholder', 'email@example.com')}
                  placeholderTextColor={c.textMuted}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  value={e.address}
                  onChangeText={(v) => {
                    const next = [...form.emails];
                    next[i] = { ...e, address: v };
                    updateForm('emails', next);
                  }}
                />
                <Pills
                  value={e.context}
                  options={opts.contexts}
                  onChange={(v) => {
                    const next = [...form.emails];
                    next[i] = { ...e, context: v };
                    updateForm('emails', next);
                  }}
                />
              </RemovableRow>
            ))}
            <AddButton
              label={t('contacts.form.add_email', 'Add email')}
              onPress={() => updateForm('emails', [...form.emails, { address: '', context: '' }])}
            />
          </Section>

          {/* Phone */}
          <Section icon={<Phone size={16} color={c.textMuted} />} label={t('contacts.form.phone', 'Phone')}>
            {form.phones.map((p, i) => (
              <RemovableRow
                key={i}
                onRemove={() => updateForm('phones', form.phones.filter((_, idx) => idx !== i))}
              >
                <TextInput
                  style={styles.input}
                  placeholder={t('contacts.form.phone_placeholder', '+1 234 567 890')}
                  placeholderTextColor={c.textMuted}
                  keyboardType="phone-pad"
                  value={p.number}
                  onChangeText={(v) => {
                    const next = [...form.phones];
                    next[i] = { ...p, number: v };
                    updateForm('phones', next);
                  }}
                />
                <Pills
                  value={p.feature}
                  options={opts.phoneFeatures}
                  onChange={(v) => {
                    const next = [...form.phones];
                    next[i] = { ...p, feature: v };
                    updateForm('phones', next);
                  }}
                />
                <Pills
                  value={p.context}
                  options={opts.contexts}
                  onChange={(v) => {
                    const next = [...form.phones];
                    next[i] = { ...p, context: v };
                    updateForm('phones', next);
                  }}
                />
              </RemovableRow>
            ))}
            <AddButton
              label={t('contacts.form.add_phone', 'Add phone')}
              onPress={() => updateForm('phones', [...form.phones, { number: '', context: '', feature: '' }])}
            />
          </Section>

          {/* Work */}
          <Section
            icon={<Building size={16} color={c.textMuted} />}
            label={t('contacts.form.section_work', 'Work & Organization')}
            collapsible
            defaultOpen={form.orgs.length > 0}
          >
            {form.orgs.map((o, i) => (
              <RemovableRow
                key={i}
                onRemove={() => updateForm('orgs', form.orgs.filter((_, idx) => idx !== i))}
              >
                {!(form.isOrg && i === 0) && (
                  <Field label={t('contacts.form.organization', 'Organization')}>
                    <TextInput
                      style={styles.input}
                      placeholder={t('contacts.form.organization_placeholder', 'Company name')}
                      placeholderTextColor={c.textMuted}
                      value={o.name}
                      onChangeText={(v) => {
                        const next = [...form.orgs];
                        next[i] = { ...o, name: v };
                        updateForm('orgs', next);
                      }}
                    />
                  </Field>
                )}
                <Field label={t('contacts.form.department', 'Department')}>
                  <TextInput
                    style={styles.input}
                    placeholder={t('contacts.form.department_placeholder', 'Department')}
                    placeholderTextColor={c.textMuted}
                    value={o.department}
                    onChangeText={(v) => {
                      const next = [...form.orgs];
                      next[i] = { ...o, department: v };
                      updateForm('orgs', next);
                    }}
                  />
                </Field>
                <Field label={t('contacts.form.job_title', 'Job title')}>
                  <TextInput
                    style={styles.input}
                    placeholder={t('contacts.form.job_title_placeholder', 'e.g., Software Engineer')}
                    placeholderTextColor={c.textMuted}
                    value={o.jobTitle}
                    onChangeText={(v) => {
                      const next = [...form.orgs];
                      next[i] = { ...o, jobTitle: v };
                      updateForm('orgs', next);
                    }}
                  />
                </Field>
                <Field label={t('contacts.form.role', 'Role')}>
                  <TextInput
                    style={styles.input}
                    placeholder={t('contacts.form.role_placeholder', 'e.g., Team Lead')}
                    placeholderTextColor={c.textMuted}
                    value={o.role}
                    onChangeText={(v) => {
                      const next = [...form.orgs];
                      next[i] = { ...o, role: v };
                      updateForm('orgs', next);
                    }}
                  />
                </Field>
              </RemovableRow>
            ))}
            <AddButton
              label={t('contacts.form.add_organization', 'Add organization')}
              onPress={() => updateForm('orgs', [...form.orgs, { name: '', department: '', jobTitle: '', role: '' }])}
            />
          </Section>

          {/* Address */}
          <Section
            icon={<MapPin size={16} color={c.textMuted} />}
            label={t('contacts.detail.address_default_label', 'Address')}
            collapsible
            defaultOpen={form.addresses.length > 0}
          >
            {form.addresses.map((a, i) => (
              <RemovableRow
                key={i}
                onRemove={() => updateForm('addresses', form.addresses.filter((_, idx) => idx !== i))}
              >
                <TextInput
                  style={styles.input}
                  placeholder={t('contacts.form.street', 'Street')}
                  placeholderTextColor={c.textMuted}
                  value={a.street}
                  onChangeText={(v) => {
                    const next = [...form.addresses];
                    next[i] = { ...a, street: v };
                    updateForm('addresses', next);
                  }}
                />
                <View style={styles.row2}>
                  <Field>
                    <TextInput
                      style={styles.input}
                      placeholder={t('contacts.form.city', 'City')}
                      placeholderTextColor={c.textMuted}
                      value={a.locality}
                      onChangeText={(v) => {
                        const next = [...form.addresses];
                        next[i] = { ...a, locality: v };
                        updateForm('addresses', next);
                      }}
                    />
                  </Field>
                  <Field>
                    <TextInput
                      style={styles.input}
                      placeholder={t('contacts.form.region', 'State / Region')}
                      placeholderTextColor={c.textMuted}
                      value={a.region}
                      onChangeText={(v) => {
                        const next = [...form.addresses];
                        next[i] = { ...a, region: v };
                        updateForm('addresses', next);
                      }}
                    />
                  </Field>
                </View>
                <View style={styles.row2}>
                  <Field>
                    <TextInput
                      style={styles.input}
                      placeholder={t('contacts.form.postcode', 'Postal code')}
                      placeholderTextColor={c.textMuted}
                      value={a.postcode}
                      onChangeText={(v) => {
                        const next = [...form.addresses];
                        next[i] = { ...a, postcode: v };
                        updateForm('addresses', next);
                      }}
                    />
                  </Field>
                  <Field>
                    <TextInput
                      style={styles.input}
                      placeholder={t('contacts.form.country', 'Country')}
                      placeholderTextColor={c.textMuted}
                      value={a.country}
                      onChangeText={(v) => {
                        const next = [...form.addresses];
                        next[i] = { ...a, country: v };
                        updateForm('addresses', next);
                      }}
                    />
                  </Field>
                </View>
                <Pills
                  value={a.context}
                  options={opts.contexts}
                  onChange={(v) => {
                    const next = [...form.addresses];
                    next[i] = { ...a, context: v };
                    updateForm('addresses', next);
                  }}
                />
              </RemovableRow>
            ))}
            <AddButton
              label={t('contacts.form.add_address', 'Add address')}
              onPress={() =>
                updateForm('addresses', [...form.addresses, {
                  street: '', locality: '', region: '', postcode: '', country: '', context: '',
                }])
              }
            />
          </Section>

          {/* Online services */}
          <Section
            icon={<Globe size={16} color={c.textMuted} />}
            label={t('contacts.form.online_services', 'Online Services')}
            collapsible
            defaultOpen={form.online.length > 0}
          >
            {form.online.map((s, i) => (
              <RemovableRow
                key={i}
                onRemove={() => updateForm('online', form.online.filter((_, idx) => idx !== i))}
              >
                <Field label={t('contacts.form.url', 'URL')}>
                  <TextInput
                    style={styles.input}
                    placeholder={t('contacts.form.url_placeholder', 'https://...')}
                    placeholderTextColor={c.textMuted}
                    autoCapitalize="none"
                    value={s.uri}
                    onChangeText={(v) => {
                      const next = [...form.online];
                      next[i] = { ...s, uri: v };
                      updateForm('online', next);
                    }}
                  />
                </Field>
                <View style={styles.row2}>
                  <Field label={t('contacts.form.service_placeholder', 'Service')}>
                    <TextInput
                      style={styles.input}
                      placeholder="LinkedIn, Mastodon, …"
                      placeholderTextColor={c.textMuted}
                      value={s.service}
                      onChangeText={(v) => {
                        const next = [...form.online];
                        next[i] = { ...s, service: v };
                        updateForm('online', next);
                      }}
                    />
                  </Field>
                  <Field label={t('contacts.form.label', 'Label')}>
                    <TextInput
                      style={styles.input}
                      placeholder={t('contacts.form.label_placeholder', 'Work, Personal, …')}
                      placeholderTextColor={c.textMuted}
                      value={s.label}
                      onChangeText={(v) => {
                        const next = [...form.online];
                        next[i] = { ...s, label: v };
                        updateForm('online', next);
                      }}
                    />
                  </Field>
                </View>
              </RemovableRow>
            ))}
            <AddButton
              label={t('contacts.form.add_online_service', 'Add online service')}
              onPress={() => updateForm('online', [...form.online, { uri: '', service: '', label: '' }])}
            />
          </Section>

          {/* Anniversaries */}
          <Section
            icon={<Cake size={16} color={c.textMuted} />}
            label={t('contacts.form.anniversaries', 'Anniversaries')}
            collapsible
            defaultOpen={form.anniversaries.length > 0}
          >
            {form.anniversaries.map((a, i) => (
              <RemovableRow
                key={i}
                onRemove={() => updateForm('anniversaries', form.anniversaries.filter((_, idx) => idx !== i))}
              >
                <View style={styles.dateInputRow}>
                  <TextInput
                    style={[
                      styles.input,
                      { flex: 1 },
                      a.date.trim() && !stringToPartialDate(a.date) ? styles.inputInvalid : null,
                    ]}
                    placeholder={t('contacts.form.date_placeholder', 'YYYY-MM-DD, YYYY-MM, YYYY or --MM-DD')}
                    placeholderTextColor={c.textMuted}
                    value={a.date}
                    onChangeText={(v) => {
                      const next = [...form.anniversaries];
                      next[i] = { ...a, date: v };
                      updateForm('anniversaries', next);
                    }}
                  />
                  <Pressable
                    onPress={() => setDatePickerIndex(i)}
                    style={styles.datePickerBtn}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('contacts.form.pick_date', 'Pick a date')}
                  >
                    <Calendar size={18} color={c.primary} />
                  </Pressable>
                </View>
                <Pills
                  value={a.kind}
                  options={opts.anniversaryKinds}
                  onChange={(v) => {
                    const next = [...form.anniversaries];
                    next[i] = { ...a, kind: v };
                    updateForm('anniversaries', next);
                  }}
                />
              </RemovableRow>
            ))}
            <AddButton
              label={t('contacts.form.add_anniversary', 'Add date')}
              onPress={() => updateForm('anniversaries', [...form.anniversaries, { kind: 'birth', date: '' }])}
            />
          </Section>

          {/* Personal info */}
          <Section
            icon={<Heart size={16} color={c.textMuted} />}
            label={t('contacts.form.personal_info', 'Personal Info')}
            collapsible
            defaultOpen={form.personalInfo.length > 0}
          >
            {form.personalInfo.map((pi, i) => (
              <RemovableRow
                key={i}
                onRemove={() => updateForm('personalInfo', form.personalInfo.filter((_, idx) => idx !== i))}
              >
                <TextInput
                  style={styles.input}
                  placeholder={t('contacts.form.personal_info_placeholder', 'e.g., Photography')}
                  placeholderTextColor={c.textMuted}
                  value={pi.value}
                  onChangeText={(v) => {
                    const next = [...form.personalInfo];
                    next[i] = { ...pi, value: v };
                    updateForm('personalInfo', next);
                  }}
                />
                <Pills
                  value={pi.kind}
                  options={opts.personalInfoKinds}
                  onChange={(v) => {
                    const next = [...form.personalInfo];
                    next[i] = { ...pi, kind: v };
                    updateForm('personalInfo', next);
                  }}
                />
                <Pills
                  value={pi.level}
                  options={opts.personalInfoLevels}
                  onChange={(v) => {
                    const next = [...form.personalInfo];
                    next[i] = { ...pi, level: v };
                    updateForm('personalInfo', next);
                  }}
                />
              </RemovableRow>
            ))}
            <AddButton
              label={t('contacts.form.add_personal_info', 'Add entry')}
              onPress={() => updateForm('personalInfo', [...form.personalInfo, { kind: 'hobby', level: '', value: '' }])}
            />
          </Section>

          {/* Gender */}
          {!form.isOrg && (
            <Section
              icon={<UserCircle size={16} color={c.textMuted} />}
              label={t('contacts.form.gender', 'Gender')}
              collapsible
              defaultOpen={!!(form.grammaticalGender || form.pronouns)}
            >
              <Field label={t('contacts.form.grammatical_gender', 'Grammatical gender')}>
                <Pills
                  value={form.grammaticalGender}
                  options={
                    // Values from other clients (RFC 9554 GRAMGENDER: common,
                    // neuter, animate, inanimate) stay selectable so a save
                    // never silently drops them.
                    form.grammaticalGender && !opts.gender.some((o) => o.value === form.grammaticalGender)
                      ? [...opts.gender, { value: form.grammaticalGender, label: form.grammaticalGender }]
                      : opts.gender
                  }
                  onChange={(v) => updateForm('grammaticalGender', v)}
                />
              </Field>
              <Field label={t('contacts.form.pronouns', 'Pronouns')}>
                <TextInput
                  style={styles.input}
                  placeholder={t('contacts.form.pronouns_placeholder', 'they/them')}
                  placeholderTextColor={c.textMuted}
                  value={form.pronouns}
                  onChangeText={(v) => updateForm('pronouns', v)}
                />
              </Field>
            </Section>
          )}

          {/* Calendar */}
          <Section
            icon={<Calendar size={16} color={c.textMuted} />}
            label={t('contacts.form.calendar', 'Calendar')}
            collapsible
            defaultOpen={!!(form.calendarUri || form.schedulingUri || form.freeBusyUri)}
          >
            <Field label={t('contacts.form.calendar_uri', 'Calendar URL')}>
              <TextInput
                style={styles.input}
                placeholder={t('contacts.form.url_placeholder', 'https://...')}
                placeholderTextColor={c.textMuted}
                autoCapitalize="none"
                value={form.calendarUri}
                onChangeText={(v) => updateForm('calendarUri', v)}
              />
            </Field>
            <Field label={t('contacts.form.scheduling_uri', 'Scheduling URL')}>
              <TextInput
                style={styles.input}
                placeholder={t('contacts.form.url_placeholder', 'https://...')}
                placeholderTextColor={c.textMuted}
                autoCapitalize="none"
                value={form.schedulingUri}
                onChangeText={(v) => updateForm('schedulingUri', v)}
              />
            </Field>
            <Field label={t('contacts.form.freebusy_uri', 'Free/Busy URL')}>
              <TextInput
                style={styles.input}
                placeholder={t('contacts.form.url_placeholder', 'https://...')}
                placeholderTextColor={c.textMuted}
                autoCapitalize="none"
                value={form.freeBusyUri}
                onChangeText={(v) => updateForm('freeBusyUri', v)}
              />
            </Field>
          </Section>

          {categoriesSection}
          {notesSection}
        </ScrollView>
      </KeyboardAvoidingView>

      {discardDialog}

      {datePickerIndex !== null && (() => {
        const draft = form.anniversaries[datePickerIndex];
        const parsed = draft ? parseDateDraft(draft.date) : new Date();
        const onChange = (event: DateTimePickerEvent, selected?: Date) => {
          if (Platform.OS === 'android') {
            setDatePickerIndex(null);
          }
          if (event.type === 'dismissed' || !selected) return;
          const iso = formatDateAsISO(selected);
          const next = [...form.anniversaries];
          if (next[datePickerIndex]) {
            next[datePickerIndex] = { ...next[datePickerIndex], date: iso };
            updateForm('anniversaries', next);
          }
        };
        if (Platform.OS === 'ios') {
          return (
            <Modal transparent animationType="fade" onRequestClose={() => setDatePickerIndex(null)}>
              <Pressable style={styles.pickerOverlay} onPress={() => setDatePickerIndex(null)} />
              <View style={styles.pickerSheet}>
                <View style={styles.pickerHeader}>
                  <Pressable onPress={() => setDatePickerIndex(null)} hitSlop={8}>
                    <Text style={styles.pickerDone}>{t('common.done', 'Done')}</Text>
                  </Pressable>
                </View>
                <DateTimePicker
                  value={parsed}
                  mode="date"
                  display="spinner"
                  onChange={onChange}
                />
              </View>
            </Modal>
          );
        }
        return (
          <DateTimePicker
            value={parsed}
            mode="date"
            display="default"
            onChange={onChange}
          />
        );
      })()}
    </SafeAreaView>
  );
}

function parseDateDraft(s: string): Date {
  const pd = stringToPartialDate(s);
  const now = new Date();
  if (!pd) return now;
  return new Date(pd.year ?? now.getFullYear(), (pd.month ?? 1) - 1, pd.day ?? 1);
}

function formatDateAsISO(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    missing: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
    missingText: { ...typography.body, color: c.textMuted },
    scrollContent: {
      paddingVertical: spacing.md,
      paddingBottom: spacing.xxxl * 2,
      paddingHorizontal: spacing.lg,
      gap: spacing.lg,
    },

    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      gap: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    headerBtn: {
      width: 40, height: 40,
      alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.full,
    },
    headerTitle: { ...typography.h3, color: c.text, flex: 1 },
    saveBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      height: 36,
      backgroundColor: c.primary,
      borderRadius: radius.full,
    },
    saveLabel: { ...typography.bodyMedium, color: c.primaryForeground },

    photoPanel: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    photoBtn: { borderRadius: 999 },
    photoThumb: {
      width: 80, height: 80,
      borderRadius: 40,
      backgroundColor: c.surface,
    },
    photoPlaceholder: {
      alignItems: 'center', justifyContent: 'center',
      borderWidth: 1, borderColor: c.border, borderStyle: 'dashed',
    },
    previewName: { ...typography.h3, color: c.text },
    previewHint: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    removePhotoBtn: { marginTop: spacing.xs },
    removePhotoLabel: { ...typography.caption, color: c.error },

    section: { gap: spacing.sm },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    sectionIcon: { width: 16 },
    sectionLabel: {
      flex: 1,
      ...typography.bodyMedium,
      color: c.textSecondary,
      textTransform: 'uppercase',
      fontSize: fontPx(11),
      letterSpacing: 0.6,
    },
    sectionBody: { gap: spacing.sm, paddingLeft: spacing.lg + spacing.xs },

    field: { gap: 4 },
    fieldLabel: { ...typography.caption, color: c.textMuted },
    row2: { flexDirection: 'row', gap: spacing.sm },

    input: {
      minHeight: componentSizes.inputHeight,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.surface,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      ...typography.body,
      color: c.text,
    },
    inputInvalid: { borderColor: c.error },
    multiline: {
      minHeight: 80,
      paddingVertical: spacing.sm,
      textAlignVertical: 'top',
    },

    pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    pill: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.full,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    pillActive: { backgroundColor: c.primary, borderColor: c.primary },
    pillText: { ...typography.caption, color: c.textSecondary },
    pillTextActive: { color: c.primaryForeground },

    removableRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.xs,
      paddingVertical: spacing.xs,
      borderTopWidth: 1,
      borderTopColor: c.borderLight,
      paddingTop: spacing.sm,
    },
    removeBtn: {
      width: 26, height: 26,
      alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.full,
      backgroundColor: c.surface,
      marginTop: 6,
    },

    memberName: { ...typography.body, color: c.text, marginTop: 6 },
    memberEmail: { ...typography.caption, color: c.textMuted },

    addBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      alignSelf: 'flex-start',
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      borderRadius: radius.full,
      backgroundColor: c.primaryBg,
    },
    addBtnPressed: { backgroundColor: c.surfaceHover },
    addBtnLabel: { ...typography.caption, color: c.primary },

    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    keywordChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.full,
      backgroundColor: c.primaryBg,
    },
    keywordChipText: { ...typography.caption, color: c.primary },
    suggestedChip: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.full,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    suggestedChipText: { ...typography.caption, color: c.textSecondary },

    dateInputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    datePickerBtn: {
      width: 40, height: 40,
      alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.full,
      backgroundColor: c.primaryBg,
    },

    pickerOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    pickerSheet: {
      position: 'absolute',
      left: 0, right: 0, bottom: 0,
      backgroundColor: c.background,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingBottom: spacing.lg,
    },
    pickerHeader: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      padding: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    pickerDone: { ...typography.bodySemibold, color: c.primary },
  });
}
