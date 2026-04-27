import React from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, TextInput, Alert,
  KeyboardAvoidingView, Platform, Modal, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import {
  ArrowLeft, Mail, Phone, Building, MapPin, Cake, Tag, FileText, User, Check, Calendar,
  Camera, X as XIcon,
} from 'lucide-react-native';
import type { RootStackParamList } from '../navigation/types';
import type {
  ContactCard, ContactEmail, ContactPhone, ContactAddress, ContactOrganization,
  ContactAnniversary, ContactNote, ContactMedia, PartialDate,
} from '../api/types';
import { useContactsStore } from '../stores/contacts-store';
import { getContactKeywords } from '../lib/contact-utils';
import { getContactDisplayName } from '../lib/contact-utils';
import FieldBlock, { FieldRow } from '../components/contacts/FieldBlock';
import Dialog from '../components/Dialog';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ContactForm'>;
type Route = RouteProp<RootStackParamList, 'ContactForm'>;

interface EmailDraft { address: string; label: string; context: string }
interface PhoneDraft { number: string; label: string; context: string }
interface AddressDraft { full: string; context: string }
interface OrgDraft { name: string; title: string }
interface AnniversaryDraft { kind: string; date: string } // YYYY-MM-DD or --MM-DD
interface NoteDraft { note: string }

interface FormState {
  given: string;
  surname: string;
  full: string;
  emails: EmailDraft[];
  phones: PhoneDraft[];
  addresses: AddressDraft[];
  orgs: OrgDraft[];
  anniversaries: AnniversaryDraft[];
  notes: NoteDraft[];
  keywords: string[];
  addressBookId: string;
  photoUri: string;
  photoMediaType: string;
}

function blankForm(): FormState {
  return {
    given: '',
    surname: '',
    full: '',
    emails: [{ address: '', label: '', context: 'personal' }],
    phones: [],
    addresses: [],
    orgs: [],
    anniversaries: [],
    notes: [],
    keywords: [],
    addressBookId: '',
    photoUri: '',
    photoMediaType: '',
  };
}

function partialDateToString(d: ContactAnniversary['date']): string {
  if (typeof d === 'string') return d;
  if (typeof d === 'object' && d) {
    if ('@type' in d && d['@type'] === 'Timestamp') return d.utc;
    const pd = d as PartialDate;
    const yr = pd.year ? String(pd.year).padStart(4, '0') : '';
    const mo = pd.month ? String(pd.month).padStart(2, '0') : '';
    const da = pd.day ? String(pd.day).padStart(2, '0') : '';
    if (yr) return `${yr}-${mo || '01'}-${da || '01'}`;
    if (mo || da) return `--${mo}-${da}`;
  }
  return '';
}

function stringToAnniversaryDate(s: string): string | PartialDate | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map((n) => parseInt(n, 10));
    return { year: y, month: m, day: d };
  }
  if (/^--\d{2}-\d{2}$/.test(trimmed)) {
    const [, , mo, da] = trimmed.split('-');
    return { month: parseInt(mo, 10), day: parseInt(da, 10) };
  }
  return trimmed;
}

function contactToForm(contact: ContactCard): FormState {
  const nameComp = contact.name?.components || [];
  const given = nameComp.find((c) => c.kind === 'given')?.value || '';
  const surname = nameComp.find((c) => c.kind === 'surname')?.value || '';
  const full = contact.name?.full || '';

  const emails = contact.emails ? Object.values(contact.emails).map((e) => ({
    address: e.address,
    label: e.label || '',
    context: Object.keys(e.contexts || {}).find((k) => e.contexts![k]) || 'personal',
  })) : [];

  const phones = contact.phones ? Object.values(contact.phones).map((p) => ({
    number: p.number,
    label: p.label || '',
    context: Object.keys(p.contexts || {}).find((k) => p.contexts![k]) || 'personal',
  })) : [];

  const addresses = contact.addresses ? Object.values(contact.addresses).map((a) => ({
    full: a.full || a.fullAddress || [a.street, a.locality, a.region, a.postcode, a.country].filter(Boolean).join(', '),
    context: Object.keys(a.contexts || {}).find((k) => a.contexts![k]) || 'home',
  })) : [];

  const orgs = contact.organizations ? Object.values(contact.organizations).map((o, i) => ({
    name: o.name || '',
    title: contact.titles ? Object.values(contact.titles)[i]?.name || '' : '',
  })) : [];

  const anniversaries = contact.anniversaries ? Object.values(contact.anniversaries).map((a) => ({
    kind: a.kind || 'birth',
    date: partialDateToString(a.date),
  })) : [];

  const notes = contact.notes ? Object.values(contact.notes).map((n) => ({ note: n.note })) : [];

  const keywords = contact.keywords
    ? Object.keys(contact.keywords).filter((k) => contact.keywords![k])
    : [];

  const addressBookId = Object.keys(contact.addressBookIds || {})
    .find((id) => contact.addressBookIds[id]) || '';

  const photoEntry = contact.media
    ? Object.values(contact.media).find((m) => m.kind === 'photo')
    : undefined;
  const photoUri = photoEntry?.uri || '';
  const photoMediaType = photoEntry?.mediaType || '';

  return {
    given, surname, full, emails, phones, addresses, orgs, anniversaries,
    notes, keywords, addressBookId, photoUri, photoMediaType,
  };
}

function formToPatch(form: FormState): Partial<ContactCard> {
  const components = [] as Array<{ kind: string; value: string }>;
  if (form.given) components.push({ kind: 'given', value: form.given });
  if (form.surname) components.push({ kind: 'surname', value: form.surname });

  const name: ContactCard['name'] | undefined =
    components.length > 0 || form.full
      ? { ...(components.length > 0 ? { components, isOrdered: true } : {}), ...(form.full ? { full: form.full } : {}) }
      : undefined;

  const emails: Record<string, ContactEmail> = {};
  form.emails.filter((e) => e.address.trim()).forEach((e, i) => {
    emails[`e${i + 1}`] = {
      address: e.address.trim(),
      ...(e.label ? { label: e.label } : {}),
      ...(e.context ? { contexts: { [e.context]: true } } : {}),
    };
  });

  const phones: Record<string, ContactPhone> = {};
  form.phones.filter((p) => p.number.trim()).forEach((p, i) => {
    phones[`p${i + 1}`] = {
      number: p.number.trim(),
      ...(p.label ? { label: p.label } : {}),
      ...(p.context ? { contexts: { [p.context]: true } } : {}),
    };
  });

  const addresses: Record<string, ContactAddress> = {};
  form.addresses.filter((a) => a.full.trim()).forEach((a, i) => {
    addresses[`a${i + 1}`] = {
      full: a.full.trim(),
      ...(a.context ? { contexts: { [a.context]: true } } : {}),
    };
  });

  const organizations: Record<string, ContactOrganization> = {};
  const titles: Record<string, { name: string }> = {};
  form.orgs.forEach((o, i) => {
    if (o.name.trim()) organizations[`o${i + 1}`] = { name: o.name.trim() };
    if (o.title.trim()) titles[`t${i + 1}`] = { name: o.title.trim() };
  });

  const anniversaries: Record<string, ContactAnniversary> = {};
  form.anniversaries.forEach((a, i) => {
    const date = stringToAnniversaryDate(a.date);
    if (!date) return;
    anniversaries[`an${i + 1}`] = { kind: a.kind, date };
  });

  const notes: Record<string, ContactNote> = {};
  form.notes.forEach((n, i) => {
    if (n.note.trim()) notes[`n${i + 1}`] = { note: n.note.trim() };
  });

  const keywords: Record<string, boolean> = {};
  form.keywords.forEach((k) => {
    if (k.trim()) keywords[k.trim()] = true;
  });

  const media: Record<string, ContactMedia> = {};
  if (form.photoUri.trim()) {
    media.photo = {
      kind: 'photo',
      uri: form.photoUri.trim(),
      ...(form.photoMediaType ? { mediaType: form.photoMediaType } : {}),
    };
  }

  return {
    ...(name ? { name } : {}),
    ...(Object.keys(emails).length ? { emails } : {}),
    ...(Object.keys(phones).length ? { phones } : {}),
    ...(Object.keys(addresses).length ? { addresses } : {}),
    ...(Object.keys(organizations).length ? { organizations } : {}),
    ...(Object.keys(titles).length ? { titles } : {}),
    ...(Object.keys(anniversaries).length ? { anniversaries } : {}),
    ...(Object.keys(notes).length ? { notes } : {}),
    ...(Object.keys(keywords).length ? { keywords } : {}),
    media,
  };
}

const EMAIL_CONTEXTS = ['personal', 'work', 'other'];
const PHONE_CONTEXTS = ['personal', 'work', 'other'];
const ADDRESS_CONTEXTS = ['home', 'work', 'other'];
const ANNIVERSARY_KINDS: Array<{ value: string; label: string }> = [
  { value: 'birth', label: 'Birthday' },
  { value: 'wedding', label: 'Anniversary' },
  { value: 'death', label: 'Memorial' },
  { value: 'other', label: 'Other' },
];

function ContextPills({
  value, options, onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.pillRow}>
      {options.map((o) => (
        <Pressable
          key={o}
          onPress={() => onChange(o)}
          style={[styles.pill, value === o && styles.pillActive]}
        >
          <Text style={[styles.pillText, value === o && styles.pillTextActive]}>{o}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function ContactFormScreen() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { contactId, addressBookId: initialBook, asGroup } = route.params || {};
  const isEdit = !!contactId;

  const addressBooks = useContactsStore((s) => s.addressBooks);
  const allContacts = useContactsStore((s) => s.contacts);
  const createContact = useContactsStore((s) => s.createContact);
  const updateContact = useContactsStore((s) => s.updateContact);
  const existing = React.useMemo(
    () => (contactId ? allContacts.find((c) => c.id === contactId) : undefined),
    [allContacts, contactId],
  );
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

  const [form, setForm] = React.useState<FormState>(() => {
    if (existing) return contactToForm(existing);
    const init = blankForm();
    if (initialBook) init.addressBookId = initialBook;
    else if (addressBooks[0]) init.addressBookId = addressBooks[0].id;
    return init;
  });
  const [keywordInput, setKeywordInput] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [datePickerIndex, setDatePickerIndex] = React.useState<number | null>(null);

  // Ensure default address book is set if books load after mount.
  React.useEffect(() => {
    if (!form.addressBookId && addressBooks[0]) {
      setForm((f) => ({ ...f, addressBookId: addressBooks[0].id }));
    }
  }, [addressBooks, form.addressBookId]);

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const handleBack = () => {
    if (dirty) {
      setConfirmDiscard(true);
    } else {
      navigation.goBack();
    }
  };

  const handleSave = async () => {
    const hasName = form.given || form.surname || form.full;
    const hasEmail = form.emails.some((e) => e.address.trim());
    if (!hasName && !hasEmail) {
      Alert.alert('Missing info', 'Add a name or at least one email.');
      return;
    }
    if (!form.addressBookId) {
      Alert.alert('Missing address book', 'Select an address book to save this contact.');
      return;
    }
    setSaving(true);
    try {
      const patch = formToPatch(form);
      if (asGroup) patch.kind = 'group';
      if (isEdit && existing) {
        await updateContact(existing.id, patch);
      } else {
        await createContact(patch, form.addressBookId);
      }
      navigation.goBack();
    } catch (err) {
      Alert.alert('Save failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  const headerTitle = isEdit
    ? `Edit ${existing ? getContactDisplayName(existing) : 'Contact'}`
    : asGroup ? 'New Group' : 'New Contact';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={handleBack} style={styles.headerBtn} hitSlop={8}>
          <ArrowLeft size={22} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{headerTitle}</Text>
        <Pressable onPress={handleSave} disabled={saving} style={styles.saveBtn} hitSlop={8}>
          {saving ? (
            <Text style={styles.saveLabel}>Saving…</Text>
          ) : (
            <>
              <Check size={16} color={c.primaryForeground} />
              <Text style={styles.saveLabel}>Save</Text>
            </>
          )}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {/* Address book picker */}
          {addressBooks.length > 1 && (
            <FieldBlock title="Address Book" icon={<User size={14} color={c.primary} />} category="contact">
              <View style={styles.pillRow}>
                {addressBooks.map((book) => (
                  <Pressable
                    key={book.id}
                    onPress={() => updateForm('addressBookId', book.id)}
                    style={[styles.pill, form.addressBookId === book.id && styles.pillActive]}
                  >
                    <Text style={[styles.pillText, form.addressBookId === book.id && styles.pillTextActive]}>
                      {book.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </FieldBlock>
          )}

          {/* Photo */}
          <FieldBlock title="Photo" icon={<Camera size={14} color={c.primary} />} category="contact">
            <View style={styles.photoRow}>
              {form.photoUri ? (
                <View style={styles.photoThumbWrap}>
                  <Image source={{ uri: form.photoUri }} style={styles.photoThumb} />
                  <Pressable
                    onPress={() => {
                      updateForm('photoUri', '');
                      updateForm('photoMediaType', '');
                    }}
                    style={styles.photoRemoveBtn}
                    hitSlop={8}
                  >
                    <XIcon size={14} color={c.primaryForeground} />
                  </Pressable>
                </View>
              ) : (
                <View style={[styles.photoThumb, styles.photoPlaceholder]}>
                  <Camera size={28} color={c.textMuted} />
                </View>
              )}
              <Pressable
                onPress={async () => {
                  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
                  if (!perm.granted) {
                    Alert.alert('Photo access needed', 'Grant photo library permission to pick a contact photo.');
                    return;
                  }
                  const result = await ImagePicker.launchImageLibraryAsync({
                    mediaTypes: ['images'],
                    allowsEditing: true,
                    aspect: [1, 1],
                    quality: 0.8,
                    base64: true,
                  });
                  if (result.canceled || !result.assets[0]) return;
                  const asset = result.assets[0];
                  const mime = asset.mimeType || 'image/jpeg';
                  if (asset.base64) {
                    updateForm('photoUri', `data:${mime};base64,${asset.base64}`);
                  } else {
                    updateForm('photoUri', asset.uri);
                  }
                  updateForm('photoMediaType', mime);
                }}
                style={styles.photoPickBtn}
              >
                <Text style={styles.photoPickLabel}>
                  {form.photoUri ? 'Change photo' : 'Choose photo'}
                </Text>
              </Pressable>
            </View>
          </FieldBlock>

          {/* Name */}
          <FieldBlock title="Name" icon={<User size={14} color={c.primary} />} category="contact">
            <TextInput
              style={styles.input}
              placeholder="First name"
              placeholderTextColor={c.textMuted}
              value={form.given}
              onChangeText={(v) => updateForm('given', v)}
            />
            <TextInput
              style={styles.input}
              placeholder="Last name"
              placeholderTextColor={c.textMuted}
              value={form.surname}
              onChangeText={(v) => updateForm('surname', v)}
            />
            <TextInput
              style={styles.input}
              placeholder="Display name (optional)"
              placeholderTextColor={c.textMuted}
              value={form.full}
              onChangeText={(v) => updateForm('full', v)}
            />
          </FieldBlock>

          {/* Emails */}
          <FieldBlock
            title="Email"
            icon={<Mail size={14} color={c.primary} />}
            category="contact"
            onAdd={() => updateForm('emails', [...form.emails, { address: '', label: '', context: 'personal' }])}
            addLabel="Add"
          >
            {form.emails.map((e, i) => (
              <FieldRow
                key={i}
                onRemove={() => updateForm('emails', form.emails.filter((_, idx) => idx !== i))}
              >
                <TextInput
                  style={styles.input}
                  placeholder="email@example.com"
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
                <ContextPills
                  value={e.context}
                  options={EMAIL_CONTEXTS}
                  onChange={(v) => {
                    const next = [...form.emails];
                    next[i] = { ...e, context: v };
                    updateForm('emails', next);
                  }}
                />
              </FieldRow>
            ))}
          </FieldBlock>

          {/* Phones */}
          <FieldBlock
            title="Phone"
            icon={<Phone size={14} color={c.primary} />}
            category="contact"
            onAdd={() => updateForm('phones', [...form.phones, { number: '', label: '', context: 'personal' }])}
            addLabel="Add"
          >
            {form.phones.map((p, i) => (
              <FieldRow
                key={i}
                onRemove={() => updateForm('phones', form.phones.filter((_, idx) => idx !== i))}
              >
                <TextInput
                  style={styles.input}
                  placeholder="+1 555 0100"
                  placeholderTextColor={c.textMuted}
                  keyboardType="phone-pad"
                  value={p.number}
                  onChangeText={(v) => {
                    const next = [...form.phones];
                    next[i] = { ...p, number: v };
                    updateForm('phones', next);
                  }}
                />
                <ContextPills
                  value={p.context}
                  options={PHONE_CONTEXTS}
                  onChange={(v) => {
                    const next = [...form.phones];
                    next[i] = { ...p, context: v };
                    updateForm('phones', next);
                  }}
                />
              </FieldRow>
            ))}
          </FieldBlock>

          {/* Orgs */}
          <FieldBlock
            title="Organization"
            icon={<Building size={14} color={c.calendar.orange} />}
            category="work"
            onAdd={() => updateForm('orgs', [...form.orgs, { name: '', title: '' }])}
            addLabel="Add"
          >
            {form.orgs.map((o, i) => (
              <FieldRow
                key={i}
                onRemove={() => updateForm('orgs', form.orgs.filter((_, idx) => idx !== i))}
              >
                <TextInput
                  style={styles.input}
                  placeholder="Company"
                  placeholderTextColor={c.textMuted}
                  value={o.name}
                  onChangeText={(v) => {
                    const next = [...form.orgs];
                    next[i] = { ...o, name: v };
                    updateForm('orgs', next);
                  }}
                />
                <TextInput
                  style={styles.input}
                  placeholder="Title"
                  placeholderTextColor={c.textMuted}
                  value={o.title}
                  onChangeText={(v) => {
                    const next = [...form.orgs];
                    next[i] = { ...o, title: v };
                    updateForm('orgs', next);
                  }}
                />
              </FieldRow>
            ))}
          </FieldBlock>

          {/* Addresses */}
          <FieldBlock
            title="Address"
            icon={<MapPin size={14} color={c.calendar.green} />}
            category="location"
            onAdd={() => updateForm('addresses', [...form.addresses, { full: '', context: 'home' }])}
            addLabel="Add"
          >
            {form.addresses.map((a, i) => (
              <FieldRow
                key={i}
                onRemove={() => updateForm('addresses', form.addresses.filter((_, idx) => idx !== i))}
              >
                <TextInput
                  style={[styles.input, styles.multiline]}
                  placeholder="Street, city, region, postcode, country"
                  placeholderTextColor={c.textMuted}
                  multiline
                  value={a.full}
                  onChangeText={(v) => {
                    const next = [...form.addresses];
                    next[i] = { ...a, full: v };
                    updateForm('addresses', next);
                  }}
                />
                <ContextPills
                  value={a.context}
                  options={ADDRESS_CONTEXTS}
                  onChange={(v) => {
                    const next = [...form.addresses];
                    next[i] = { ...a, context: v };
                    updateForm('addresses', next);
                  }}
                />
              </FieldRow>
            ))}
          </FieldBlock>

          {/* Anniversaries */}
          <FieldBlock
            title="Important Dates"
            icon={<Cake size={14} color={c.calendar.pink} />}
            category="personal"
            onAdd={() => updateForm('anniversaries', [...form.anniversaries, { kind: 'birth', date: '' }])}
            addLabel="Add"
          >
            {form.anniversaries.map((a, i) => (
              <FieldRow
                key={i}
                onRemove={() => updateForm('anniversaries', form.anniversaries.filter((_, idx) => idx !== i))}
              >
                <View style={styles.dateInputRow}>
                  <TextInput
                    style={[styles.input, styles.dateTextInput]}
                    placeholder="YYYY-MM-DD or --MM-DD"
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
                  >
                    <Calendar size={18} color={c.primary} />
                  </Pressable>
                </View>
                <ContextPills
                  value={a.kind}
                  options={ANNIVERSARY_KINDS.map((k) => k.value)}
                  onChange={(v) => {
                    const next = [...form.anniversaries];
                    next[i] = { ...a, kind: v };
                    updateForm('anniversaries', next);
                  }}
                />
              </FieldRow>
            ))}
          </FieldBlock>

          {/* Keywords */}
          <FieldBlock title="Tags" icon={<Tag size={14} color={c.calendar.teal} />} category="digital">
            <View style={styles.chipRow}>
              {form.keywords.map((kw) => (
                <Pressable
                  key={kw}
                  onPress={() => updateForm('keywords', form.keywords.filter((k) => k !== kw))}
                  style={styles.keywordChip}
                >
                  <Text style={styles.keywordChipText}>{kw}</Text>
                  <Text style={styles.keywordChipRemove}>  ×</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              style={styles.input}
              placeholder="Add tag and press Enter"
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
          </FieldBlock>

          {/* Notes */}
          <FieldBlock
            title="Notes"
            icon={<FileText size={14} color={c.calendar.purple} />}
            category="notes"
            onAdd={() => updateForm('notes', [...form.notes, { note: '' }])}
            addLabel="Add"
          >
            {form.notes.length === 0 && (
              <Pressable
                onPress={() => updateForm('notes', [{ note: '' }])}
                style={styles.addNoteBtn}
              >
                <Text style={styles.addNoteText}>Tap to add note</Text>
              </Pressable>
            )}
            {form.notes.map((n, i) => (
              <FieldRow
                key={i}
                onRemove={() => updateForm('notes', form.notes.filter((_, idx) => idx !== i))}
              >
                <TextInput
                  style={[styles.input, styles.multiline]}
                  placeholder="Notes"
                  placeholderTextColor={c.textMuted}
                  multiline
                  value={n.note}
                  onChangeText={(v) => {
                    const next = [...form.notes];
                    next[i] = { note: v };
                    updateForm('notes', next);
                  }}
                />
              </FieldRow>
            ))}
          </FieldBlock>
        </ScrollView>
      </KeyboardAvoidingView>

      <Dialog
        visible={confirmDiscard}
        title="Discard changes?"
        message="You have unsaved changes. Discard them?"
        variant="destructive"
        confirmText="Discard"
        onConfirm={() => {
          setConfirmDiscard(false);
          navigation.goBack();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />

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
                    <Text style={styles.pickerDone}>Done</Text>
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
  const trimmed = s.trim();
  const fullMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (fullMatch) {
    const y = parseInt(fullMatch[1], 10);
    const m = parseInt(fullMatch[2], 10) - 1;
    const d = parseInt(fullMatch[3], 10);
    return new Date(y, m, d);
  }
  const partial = /^--(\d{2})-?(\d{2})?$/.exec(trimmed);
  if (partial) {
    const now = new Date();
    const m = parseInt(partial[1], 10) - 1;
    const d = partial[2] ? parseInt(partial[2], 10) : 1;
    return new Date(now.getFullYear(), m, d);
  }
  return new Date();
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
  scrollContent: { paddingVertical: spacing.md, paddingBottom: spacing.xxxl * 2 },

  dateInputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  dateTextInput: { flex: 1 },
  datePickerBtn: {
    width: 40, height: 40,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: c.primaryBg,
  },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  photoThumbWrap: { position: 'relative' },
  photoThumb: {
    width: 72, height: 72,
    borderRadius: 36,
    backgroundColor: c.surface,
  },
  photoPlaceholder: {
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: c.border, borderStyle: 'dashed',
  },
  photoRemoveBtn: {
    position: 'absolute',
    top: -4, right: -4,
    width: 24, height: 24,
    borderRadius: 12,
    backgroundColor: c.error,
    alignItems: 'center', justifyContent: 'center',
  },
  photoPickBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: c.primaryBg,
  },
  photoPickLabel: { ...typography.bodyMedium, color: c.primary },
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

  input: {
    height: componentSizes.inputHeight,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    backgroundColor: c.background,
    paddingHorizontal: spacing.md,
    ...typography.body,
    color: c.text,
  },
  multiline: { height: 80, paddingVertical: spacing.sm, textAlignVertical: 'top' },

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

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  keywordChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: c.primaryBg,
  },
  keywordChipText: { ...typography.caption, color: c.primary },
  keywordChipRemove: { ...typography.caption, color: c.primary },
  suggestedChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  suggestedChipText: { ...typography.caption, color: c.textSecondary },

  addNoteBtn: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  addNoteText: { ...typography.caption, color: c.textMuted },
  });
}
