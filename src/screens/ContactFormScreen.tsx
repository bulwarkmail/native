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
  Camera, X as XIcon, Globe, Heart, UserCircle, Plus, ChevronDown, ChevronRight, Book,
} from 'lucide-react-native';
import type { RootStackParamList } from '../navigation/types';
import type {
  ContactCard, ContactEmail, ContactPhone, ContactAddress, ContactOrganization,
  ContactAnniversary, ContactNote, ContactMedia, PartialDate, ContactOnlineService,
  ContactPersonalInfo, ContactNickname,
} from '../api/types';
import { useContactsStore } from '../stores/contacts-store';
import { getContactKeywords, getContactDisplayName } from '../lib/contact-utils';
import Dialog from '../components/Dialog';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ContactForm'>;
type Route = RouteProp<RootStackParamList, 'ContactForm'>;

interface EmailDraft { address: string; context: string }
interface PhoneDraft { number: string; context: string; feature: string }
interface AddressDraft {
  street: string;
  locality: string;
  region: string;
  postcode: string;
  country: string;
  context: string;
}
interface OrgDraft { name: string; department: string; jobTitle: string; role: string }
interface AnniversaryDraft { kind: string; date: string }
interface OnlineDraft { uri: string; service: string }
interface PersonalInfoDraft { kind: string; level: string; value: string }
interface NoteDraft { note: string }

interface FormState {
  prefix: string;
  given: string;
  middle: string;
  surname: string;
  suffix: string;
  full: string;
  nickname: string;
  emails: EmailDraft[];
  phones: PhoneDraft[];
  addresses: AddressDraft[];
  orgs: OrgDraft[];
  anniversaries: AnniversaryDraft[];
  online: OnlineDraft[];
  personalInfo: PersonalInfoDraft[];
  notes: NoteDraft[];
  keywords: string[];
  grammaticalGender: string;
  pronouns: string;
  calendarUri: string;
  schedulingUri: string;
  freeBusyUri: string;
  addressBookId: string;
  photoUri: string;
  photoMediaType: string;
}

function blankForm(): FormState {
  return {
    prefix: '',
    given: '',
    middle: '',
    surname: '',
    suffix: '',
    full: '',
    nickname: '',
    emails: [{ address: '', context: '' }],
    phones: [],
    addresses: [],
    orgs: [],
    anniversaries: [],
    online: [],
    personalInfo: [],
    notes: [],
    keywords: [],
    grammaticalGender: '',
    pronouns: '',
    calendarUri: '',
    schedulingUri: '',
    freeBusyUri: '',
    addressBookId: '',
    photoUri: '',
    photoMediaType: '',
  };
}

function partialDateToString(d: ContactAnniversary['date']): string {
  if (typeof d === 'string') return d;
  if (typeof d === 'object' && d) {
    if ('@type' in d && d['@type'] === 'Timestamp') return d.utc.split('T')[0];
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

function findNameComponent(contact: ContactCard | undefined, ...kinds: string[]): string {
  if (!contact?.name?.components) return '';
  const found = contact.name.components.find((c) => kinds.includes(c.kind as string));
  return found?.value || '';
}

function addressToFlat(a: ContactAddress): AddressDraft {
  if (a.components && a.components.length > 0) {
    const collect = (kind: string) => a.components!.filter((c) => c.kind === kind).map((c) => c.value).join(' ');
    const number = collect('number');
    const name = collect('name');
    return {
      street: [number, name].filter(Boolean).join(' ') || a.street || '',
      locality: collect('locality') || a.locality || '',
      region: collect('region') || a.region || '',
      postcode: collect('postcode') || a.postcode || '',
      country: collect('country') || a.country || '',
      context: a.contexts?.work ? 'work' : a.contexts?.private ? 'private' : '',
    };
  }
  return {
    street: a.street || '',
    locality: a.locality || '',
    region: a.region || '',
    postcode: a.postcode || '',
    country: a.country || '',
    context: a.contexts?.work ? 'work' : a.contexts?.private ? 'private' : '',
  };
}

function contactToForm(contact: ContactCard): FormState {
  const prefix = findNameComponent(contact, 'title', 'prefix');
  const given = findNameComponent(contact, 'given');
  const middle = findNameComponent(contact, 'given2', 'additional', 'middle');
  const surname = findNameComponent(contact, 'surname');
  const suffix = findNameComponent(contact, 'generation', 'suffix');
  const full = contact.name?.full || '';

  const nickname = contact.nicknames
    ? Object.values(contact.nicknames)[0]?.name || ''
    : '';

  const emails = contact.emails ? Object.values(contact.emails).map((e) => ({
    address: e.address,
    context: e.contexts?.work ? 'work' : e.contexts?.private ? 'private' : '',
  })) : [];

  const phones = contact.phones ? Object.values(contact.phones).map((p) => ({
    number: p.number,
    context: p.contexts?.work ? 'work' : p.contexts?.private ? 'private' : '',
    feature:
      p.features?.cell ? 'cell'
      : p.features?.fax ? 'fax'
      : p.features?.pager ? 'pager'
      : p.features?.video ? 'video'
      : p.features?.text ? 'text'
      : p.features?.voice ? 'voice'
      : '',
  })) : [];

  const addresses = contact.addresses ? Object.values(contact.addresses).map(addressToFlat) : [];

  // Pair organization and titles into a single "work" record per index.
  const rawOrgs = contact.organizations ? Object.values(contact.organizations) : [];
  const titles = contact.titles ? Object.values(contact.titles) : [];
  const orgs: OrgDraft[] = [];
  const maxLen = Math.max(rawOrgs.length, titles.length);
  for (let i = 0; i < maxLen; i++) {
    const o = rawOrgs[i];
    const t = titles[i];
    orgs.push({
      name: o?.name || '',
      department: o?.units?.[0]?.name || '',
      jobTitle: t?.kind !== 'role' ? t?.name || '' : '',
      role: t?.kind === 'role' ? t.name : '',
    });
  }

  const anniversaries = contact.anniversaries ? Object.values(contact.anniversaries).map((a) => ({
    kind: a.kind || 'birth',
    date: partialDateToString(a.date),
  })) : [];

  const online = contact.onlineServices ? Object.values(contact.onlineServices).map((s) => ({
    uri: s.uri || '',
    service: s.service || '',
  })) : [];

  const personalInfo = contact.personalInfo ? Object.values(contact.personalInfo).map((pi) => ({
    kind: pi.kind || 'hobby',
    level: pi.level || '',
    value: pi.value || '',
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

  const grammaticalGender = contact.speakToAs?.grammaticalGender || '';
  const pronouns = contact.speakToAs?.pronouns
    ? Object.values(contact.speakToAs.pronouns)[0]?.pronouns || ''
    : '';

  return {
    prefix, given, middle, surname, suffix, full, nickname,
    emails: emails.length > 0 ? emails : [{ address: '', context: '' }],
    phones, addresses, orgs, anniversaries, online,
    personalInfo, notes, keywords, addressBookId, photoUri, photoMediaType,
    grammaticalGender, pronouns,
    calendarUri: contact.calendarUri || '',
    schedulingUri: contact.schedulingUri || '',
    freeBusyUri: contact.freeBusyUri || '',
  };
}

function formToPatch(form: FormState): Partial<ContactCard> {
  const components: Array<{ kind: string; value: string }> = [];
  if (form.prefix) components.push({ kind: 'title', value: form.prefix });
  if (form.given) components.push({ kind: 'given', value: form.given });
  if (form.middle) components.push({ kind: 'given2', value: form.middle });
  if (form.surname) components.push({ kind: 'surname', value: form.surname });
  if (form.suffix) components.push({ kind: 'generation', value: form.suffix });

  const name: ContactCard['name'] | undefined =
    components.length > 0 || form.full
      ? { ...(components.length > 0 ? { components, isOrdered: true } : {}), ...(form.full ? { full: form.full } : {}) }
      : undefined;

  const nicknames: Record<string, ContactNickname> | undefined =
    form.nickname.trim() ? { n0: { name: form.nickname.trim() } } : undefined;

  const emails: Record<string, ContactEmail> = {};
  form.emails.filter((e) => e.address.trim()).forEach((e, i) => {
    emails[`e${i + 1}`] = {
      address: e.address.trim(),
      ...(e.context ? { contexts: { [e.context]: true } } : {}),
    };
  });

  const phones: Record<string, ContactPhone> = {};
  form.phones.filter((p) => p.number.trim()).forEach((p, i) => {
    phones[`p${i + 1}`] = {
      number: p.number.trim(),
      ...(p.context ? { contexts: { [p.context]: true } } : {}),
      ...(p.feature ? { features: { [p.feature]: true } } : {}),
    };
  });

  const addresses: Record<string, ContactAddress> = {};
  form.addresses
    .filter((a) => a.street.trim() || a.locality.trim() || a.country.trim() || a.region.trim() || a.postcode.trim())
    .forEach((a, i) => {
      const comps: Array<{ kind: string; value: string }> = [];
      if (a.street.trim()) comps.push({ kind: 'name', value: a.street.trim() });
      if (a.locality.trim()) comps.push({ kind: 'locality', value: a.locality.trim() });
      if (a.region.trim()) comps.push({ kind: 'region', value: a.region.trim() });
      if (a.postcode.trim()) comps.push({ kind: 'postcode', value: a.postcode.trim() });
      if (a.country.trim()) comps.push({ kind: 'country', value: a.country.trim() });
      addresses[`a${i + 1}`] = {
        components: comps,
        isOrdered: true,
        defaultSeparator: ', ',
        ...(a.context ? { contexts: { [a.context]: true } } : {}),
      };
    });

  const organizations: Record<string, ContactOrganization> = {};
  const titles: Record<string, { name: string; kind?: 'title' | 'role' }> = {};
  form.orgs.forEach((o, i) => {
    if (o.name.trim() || o.department.trim()) {
      const units = o.department.trim() ? [{ name: o.department.trim() }] : undefined;
      organizations[`o${i + 1}`] = {
        ...(o.name.trim() ? { name: o.name.trim() } : {}),
        ...(units ? { units } : {}),
      };
    }
    if (o.jobTitle.trim()) {
      titles[`t${i + 1}`] = { name: o.jobTitle.trim(), kind: 'title' };
    }
    if (o.role.trim()) {
      titles[`r${i + 1}`] = { name: o.role.trim(), kind: 'role' };
    }
  });

  const anniversaries: Record<string, ContactAnniversary> = {};
  form.anniversaries.forEach((a, i) => {
    const date = stringToAnniversaryDate(a.date);
    if (!date) return;
    anniversaries[`an${i + 1}`] = { kind: a.kind as ContactAnniversary['kind'], date };
  });

  const onlineServices: Record<string, ContactOnlineService> = {};
  form.online.filter((s) => s.uri.trim()).forEach((s, i) => {
    onlineServices[`os${i + 1}`] = {
      uri: s.uri.trim(),
      ...(s.service.trim() ? { service: s.service.trim() } : {}),
    };
  });

  const personalInfo: Record<string, ContactPersonalInfo> = {};
  form.personalInfo.filter((p) => p.value.trim()).forEach((p, i) => {
    personalInfo[`pi${i + 1}`] = {
      kind: p.kind as ContactPersonalInfo['kind'],
      value: p.value.trim(),
      ...(p.level ? { level: p.level as 'high' | 'medium' | 'low' } : {}),
    };
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

  const speakToAs =
    form.grammaticalGender || form.pronouns.trim()
      ? {
          ...(form.grammaticalGender ? { grammaticalGender: form.grammaticalGender } : {}),
          ...(form.pronouns.trim()
            ? { pronouns: { p0: { pronouns: form.pronouns.trim() } } }
            : {}),
        }
      : undefined;

  return {
    ...(name ? { name } : {}),
    ...(nicknames ? { nicknames } : {}),
    ...(Object.keys(emails).length ? { emails } : {}),
    ...(Object.keys(phones).length ? { phones } : {}),
    ...(Object.keys(addresses).length ? { addresses } : {}),
    ...(Object.keys(organizations).length ? { organizations } : {}),
    ...(Object.keys(titles).length ? { titles } : {}),
    ...(Object.keys(anniversaries).length ? { anniversaries } : {}),
    ...(Object.keys(onlineServices).length ? { onlineServices } : {}),
    ...(Object.keys(personalInfo).length ? { personalInfo } : {}),
    ...(Object.keys(notes).length ? { notes } : {}),
    ...(Object.keys(keywords).length ? { keywords } : {}),
    ...(speakToAs ? { speakToAs } : {}),
    ...(form.calendarUri.trim() ? { calendarUri: form.calendarUri.trim() } : {}),
    ...(form.schedulingUri.trim() ? { schedulingUri: form.schedulingUri.trim() } : {}),
    ...(form.freeBusyUri.trim() ? { freeBusyUri: form.freeBusyUri.trim() } : {}),
    media,
  };
}

const EMAIL_CONTEXTS: Array<{ value: string; label: string }> = [
  { value: '', label: 'None' },
  { value: 'work', label: 'Work' },
  { value: 'private', label: 'Private' },
];
const PHONE_CONTEXTS = EMAIL_CONTEXTS;
const ADDRESS_CONTEXTS: Array<{ value: string; label: string }> = [
  { value: '', label: 'None' },
  { value: 'work', label: 'Work' },
  { value: 'private', label: 'Private' },
];
const PHONE_FEATURES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Phone' },
  { value: 'voice', label: 'Voice' },
  { value: 'cell', label: 'Mobile' },
  { value: 'fax', label: 'Fax' },
  { value: 'pager', label: 'Pager' },
  { value: 'video', label: 'Video' },
  { value: 'text', label: 'Text' },
];
const ANNIVERSARY_KINDS: Array<{ value: string; label: string }> = [
  { value: 'birth', label: 'Birthday' },
  { value: 'wedding', label: 'Anniversary' },
  { value: 'death', label: 'Memorial' },
  { value: 'other', label: 'Other' },
];
const PERSONAL_INFO_KINDS: Array<{ value: string; label: string }> = [
  { value: 'hobby', label: 'Hobby' },
  { value: 'expertise', label: 'Expertise' },
  { value: 'interest', label: 'Interest' },
  { value: 'other', label: 'Other' },
];
const PERSONAL_INFO_LEVELS: Array<{ value: string; label: string }> = [
  { value: '', label: '–' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];
const GENDER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Unspecified' },
  { value: 'masculine', label: 'Masculine' },
  { value: 'feminine', label: 'Feminine' },
  { value: 'common', label: 'Common' },
  { value: 'neuter', label: 'Neuter' },
  { value: 'animate', label: 'Animate' },
  { value: 'inanimate', label: 'Inanimate' },
];

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
  return (
    <View style={styles.removableRow}>
      <View style={{ flex: 1 }}>{children}</View>
      <Pressable onPress={onRemove} hitSlop={8} style={styles.removeBtn}>
        <XIcon size={14} color={c.textMuted} />
      </Pressable>
    </View>
  );
}

function AddButton({ onPress, label }: { onPress: () => void; label: string }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.addBtn, pressed && styles.addBtnPressed]}>
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
    if (dirty) setConfirmDiscard(true);
    else navigation.goBack();
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
    // Email validity
    for (const e of form.emails) {
      if (e.address.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.address.trim())) {
        Alert.alert('Invalid email', `"${e.address}" is not a valid email address.`);
        return;
      }
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

  const previewName = [form.given, form.surname].filter(Boolean).join(' ').trim();

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
          {/* Photo + Name preview */}
          <View style={styles.photoPanel}>
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
              style={styles.photoBtn}
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
                {previewName || (asGroup ? 'New group' : 'New contact')}
              </Text>
              <Text style={styles.previewHint}>Tap photo to choose an image</Text>
              {form.photoUri ? (
                <Pressable
                  onPress={() => {
                    updateForm('photoUri', '');
                    updateForm('photoMediaType', '');
                  }}
                  style={styles.removePhotoBtn}
                  hitSlop={8}
                >
                  <Text style={styles.removePhotoLabel}>Remove photo</Text>
                </Pressable>
              ) : null}
            </View>
          </View>

          {/* Address book */}
          {addressBooks.length > 1 && (
            <Section icon={<Book size={16} color={c.textMuted} />} label="Address Book">
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
            </Section>
          )}

          {/* Identity */}
          <Section icon={<User size={16} color={c.textMuted} />} label="Identity">
            <View style={styles.row2}>
              <Field label="Prefix">
                <TextInput
                  style={styles.input}
                  placeholder="Mr."
                  placeholderTextColor={c.textMuted}
                  value={form.prefix}
                  onChangeText={(v) => updateForm('prefix', v)}
                />
              </Field>
              <Field label="Suffix">
                <TextInput
                  style={styles.input}
                  placeholder="Jr."
                  placeholderTextColor={c.textMuted}
                  value={form.suffix}
                  onChangeText={(v) => updateForm('suffix', v)}
                />
              </Field>
            </View>
            <Field label="First name">
              <TextInput
                style={styles.input}
                placeholder="First name"
                placeholderTextColor={c.textMuted}
                value={form.given}
                onChangeText={(v) => updateForm('given', v)}
              />
            </Field>
            <Field label="Middle name">
              <TextInput
                style={styles.input}
                placeholder="Middle"
                placeholderTextColor={c.textMuted}
                value={form.middle}
                onChangeText={(v) => updateForm('middle', v)}
              />
            </Field>
            <Field label="Last name">
              <TextInput
                style={styles.input}
                placeholder="Last name"
                placeholderTextColor={c.textMuted}
                value={form.surname}
                onChangeText={(v) => updateForm('surname', v)}
              />
            </Field>
            <Field label="Nickname">
              <TextInput
                style={styles.input}
                placeholder="Nickname"
                placeholderTextColor={c.textMuted}
                value={form.nickname}
                onChangeText={(v) => updateForm('nickname', v)}
              />
            </Field>
            <Field label="Display name (optional)">
              <TextInput
                style={styles.input}
                placeholder="Custom display name"
                placeholderTextColor={c.textMuted}
                value={form.full}
                onChangeText={(v) => updateForm('full', v)}
              />
            </Field>
          </Section>

          {/* Email */}
          <Section icon={<Mail size={16} color={c.textMuted} />} label="Email">
            {form.emails.map((e, i) => (
              <RemovableRow
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
                <Pills
                  value={e.context}
                  options={EMAIL_CONTEXTS}
                  onChange={(v) => {
                    const next = [...form.emails];
                    next[i] = { ...e, context: v };
                    updateForm('emails', next);
                  }}
                />
              </RemovableRow>
            ))}
            <AddButton
              label="Add email"
              onPress={() => updateForm('emails', [...form.emails, { address: '', context: '' }])}
            />
          </Section>

          {/* Phone */}
          <Section icon={<Phone size={16} color={c.textMuted} />} label="Phone">
            {form.phones.map((p, i) => (
              <RemovableRow
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
                <Pills
                  value={p.feature}
                  options={PHONE_FEATURES}
                  onChange={(v) => {
                    const next = [...form.phones];
                    next[i] = { ...p, feature: v };
                    updateForm('phones', next);
                  }}
                />
                <Pills
                  value={p.context}
                  options={PHONE_CONTEXTS}
                  onChange={(v) => {
                    const next = [...form.phones];
                    next[i] = { ...p, context: v };
                    updateForm('phones', next);
                  }}
                />
              </RemovableRow>
            ))}
            <AddButton
              label="Add phone"
              onPress={() => updateForm('phones', [...form.phones, { number: '', context: '', feature: '' }])}
            />
          </Section>

          {/* Work */}
          <Section
            icon={<Building size={16} color={c.textMuted} />}
            label="Work"
            collapsible
            defaultOpen={form.orgs.length > 0}
          >
            {form.orgs.map((o, i) => (
              <RemovableRow
                key={i}
                onRemove={() => updateForm('orgs', form.orgs.filter((_, idx) => idx !== i))}
              >
                <Field label="Organization">
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
                </Field>
                <Field label="Department">
                  <TextInput
                    style={styles.input}
                    placeholder="Department"
                    placeholderTextColor={c.textMuted}
                    value={o.department}
                    onChangeText={(v) => {
                      const next = [...form.orgs];
                      next[i] = { ...o, department: v };
                      updateForm('orgs', next);
                    }}
                  />
                </Field>
                <Field label="Job title">
                  <TextInput
                    style={styles.input}
                    placeholder="Title"
                    placeholderTextColor={c.textMuted}
                    value={o.jobTitle}
                    onChangeText={(v) => {
                      const next = [...form.orgs];
                      next[i] = { ...o, jobTitle: v };
                      updateForm('orgs', next);
                    }}
                  />
                </Field>
                <Field label="Role">
                  <TextInput
                    style={styles.input}
                    placeholder="Role"
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
              label="Add organization"
              onPress={() => updateForm('orgs', [...form.orgs, { name: '', department: '', jobTitle: '', role: '' }])}
            />
          </Section>

          {/* Address */}
          <Section
            icon={<MapPin size={16} color={c.textMuted} />}
            label="Address"
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
                  placeholder="Street"
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
                      placeholder="City"
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
                      placeholder="Region"
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
                      placeholder="Postcode"
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
                      placeholder="Country"
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
                  options={ADDRESS_CONTEXTS}
                  onChange={(v) => {
                    const next = [...form.addresses];
                    next[i] = { ...a, context: v };
                    updateForm('addresses', next);
                  }}
                />
              </RemovableRow>
            ))}
            <AddButton
              label="Add address"
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
            label="Online"
            collapsible
            defaultOpen={form.online.length > 0}
          >
            {form.online.map((s, i) => (
              <RemovableRow
                key={i}
                onRemove={() => updateForm('online', form.online.filter((_, idx) => idx !== i))}
              >
                <Field label="URL">
                  <TextInput
                    style={styles.input}
                    placeholder="https://example.com/handle"
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
                <Field label="Service">
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
              </RemovableRow>
            ))}
            <AddButton
              label="Add link"
              onPress={() => updateForm('online', [...form.online, { uri: '', service: '' }])}
            />
          </Section>

          {/* Anniversaries */}
          <Section
            icon={<Cake size={16} color={c.textMuted} />}
            label="Important dates"
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
                    style={[styles.input, { flex: 1 }]}
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
                <Pills
                  value={a.kind}
                  options={ANNIVERSARY_KINDS}
                  onChange={(v) => {
                    const next = [...form.anniversaries];
                    next[i] = { ...a, kind: v };
                    updateForm('anniversaries', next);
                  }}
                />
              </RemovableRow>
            ))}
            <AddButton
              label="Add date"
              onPress={() => updateForm('anniversaries', [...form.anniversaries, { kind: 'birth', date: '' }])}
            />
          </Section>

          {/* Personal info */}
          <Section
            icon={<Heart size={16} color={c.textMuted} />}
            label="Personal info"
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
                  placeholder="Hiking, JavaScript, …"
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
                  options={PERSONAL_INFO_KINDS}
                  onChange={(v) => {
                    const next = [...form.personalInfo];
                    next[i] = { ...pi, kind: v };
                    updateForm('personalInfo', next);
                  }}
                />
                <Pills
                  value={pi.level}
                  options={PERSONAL_INFO_LEVELS}
                  onChange={(v) => {
                    const next = [...form.personalInfo];
                    next[i] = { ...pi, level: v };
                    updateForm('personalInfo', next);
                  }}
                />
              </RemovableRow>
            ))}
            <AddButton
              label="Add"
              onPress={() => updateForm('personalInfo', [...form.personalInfo, { kind: 'hobby', level: '', value: '' }])}
            />
          </Section>

          {/* Gender */}
          <Section
            icon={<UserCircle size={16} color={c.textMuted} />}
            label="Gender"
            collapsible
            defaultOpen={!!(form.grammaticalGender || form.pronouns)}
          >
            <Field label="Grammatical gender">
              <Pills
                value={form.grammaticalGender}
                options={GENDER_OPTIONS}
                onChange={(v) => updateForm('grammaticalGender', v)}
              />
            </Field>
            <Field label="Pronouns">
              <TextInput
                style={styles.input}
                placeholder="they/them"
                placeholderTextColor={c.textMuted}
                value={form.pronouns}
                onChangeText={(v) => updateForm('pronouns', v)}
              />
            </Field>
          </Section>

          {/* Calendar */}
          <Section
            icon={<Calendar size={16} color={c.textMuted} />}
            label="Calendar"
            collapsible
            defaultOpen={!!(form.calendarUri || form.schedulingUri || form.freeBusyUri)}
          >
            <Field label="Calendar URI">
              <TextInput
                style={styles.input}
                placeholder="https://…"
                placeholderTextColor={c.textMuted}
                autoCapitalize="none"
                value={form.calendarUri}
                onChangeText={(v) => updateForm('calendarUri', v)}
              />
            </Field>
            <Field label="Scheduling URI">
              <TextInput
                style={styles.input}
                placeholder="https://…"
                placeholderTextColor={c.textMuted}
                autoCapitalize="none"
                value={form.schedulingUri}
                onChangeText={(v) => updateForm('schedulingUri', v)}
              />
            </Field>
            <Field label="Free/Busy URI">
              <TextInput
                style={styles.input}
                placeholder="https://…"
                placeholderTextColor={c.textMuted}
                autoCapitalize="none"
                value={form.freeBusyUri}
                onChangeText={(v) => updateForm('freeBusyUri', v)}
              />
            </Field>
          </Section>

          {/* Categories */}
          <Section
            icon={<Tag size={16} color={c.textMuted} />}
            label="Categories"
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
          </Section>

          {/* Notes */}
          <Section
            icon={<FileText size={16} color={c.textMuted} />}
            label="Notes"
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
              </RemovableRow>
            ))}
            <AddButton
              label="Add note"
              onPress={() => updateForm('notes', [...form.notes, { note: '' }])}
            />
          </Section>
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
      fontSize: 11,
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
