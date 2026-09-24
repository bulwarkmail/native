import React from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Linking, Alert, Image, Share,
  Animated, Dimensions, Easing, Modal,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ArrowLeft, Pencil, Trash2, Mail, Phone, MessageSquare, Share2, MapPin,
  Building, Cake, Heart, Globe, Tag, Users, FileText, BookUser,
  Copy, MoreHorizontal, Calendar as CalendarIcon, UserCircle, Languages,
  Clock, KeyRound, FolderInput, Plus,
} from 'lucide-react-native';
import type { RootStackParamList } from '../navigation/types';
import { openExternalUrl } from '../lib/open-url';
import type { ContactCard } from '../api/types';
import { useContactsStore } from '../stores/contacts-store';
import {
  getContactDisplayName, getContactPrimaryEmail, getContactPhotoUri,
  getPrimaryOrg, formatPartialDate, formatAddress,
  getContactKeywords, isGroup, getCompletedYears, getPhoneFeatures,
  getActiveContexts, getPrimaryNickname,
} from '../lib/contact-utils';
import { contactToVCard } from '../lib/vcard';
import SenderAvatar from '../components/SenderAvatar';
import Dialog from '../components/Dialog';
import { ContactActivity } from '../components/contacts/ContactActivity';
import AddressBookPickerSheet from '../components/contacts/AddressBookPickerSheet';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useLocaleStore, type TranslateFn } from '../stores/locale-store';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ContactDetail'>;
type Route = RouteProp<RootStackParamList, 'ContactDetail'>;

function formatTimestamp(s: string | undefined): string {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// JSContact stores contexts, phone features and personal-info kinds as
// English keys; show the known ones in the UI language.
function contextLabel(key: string, t: TranslateFn): string {
  switch (key) {
    case 'work': return t('contacts.form.context_work', 'Work');
    case 'private': return t('contacts.form.context_private', 'Private');
    default: return key;
  }
}

function phoneFeatureLabel(key: string, t: TranslateFn): string {
  switch (key) {
    case 'voice': return t('contacts.form.phone_voice', 'Voice');
    case 'cell': return t('contacts.form.phone_cell', 'Mobile');
    case 'fax': return t('contacts.form.phone_fax', 'Fax');
    case 'pager': return t('contacts.form.phone_pager', 'Pager');
    case 'video': return t('contacts.form.phone_video', 'Video');
    case 'text': return t('contacts.form.phone_text', 'Text');
    default: return key;
  }
}

function personalInfoLabel(kind: string, level: string | undefined, t: TranslateFn): string {
  const kindLabel =
    kind === 'hobby' ? t('contacts.detail.personal_hobby', 'Hobby')
    : kind === 'expertise' ? t('contacts.detail.personal_expertise', 'Expertise')
    : kind === 'interest' ? t('contacts.detail.personal_interest', 'Interest')
    : kind === 'other' ? t('contacts.detail.personal_other', 'Other')
    : kind;
  if (!level) return kindLabel;
  const levelLabel =
    level === 'low' ? t('contacts.form.level_low', 'Low')
    : level === 'medium' ? t('contacts.form.level_medium', 'Medium')
    : level === 'high' ? t('contacts.form.level_high', 'High')
    : level;
  return `${kindLabel} · ${levelLabel}`;
}

function genderLabel(value: string, t: TranslateFn): string {
  switch (value) {
    case 'masculine': return t('contacts.detail.gender_masculine', 'Male');
    case 'feminine': return t('contacts.detail.gender_feminine', 'Female');
    case 'other': return t('contacts.detail.gender_other', 'Other');
    case 'none': return t('contacts.detail.gender_none', 'Not applicable');
    case 'unknown': return t('contacts.detail.gender_unknown', 'Unknown');
    default: return value;
  }
}

function buildAddressLines(a: {
  components?: Array<{ kind: string; value: string }>;
  full?: string;
  fullAddress?: string;
  street?: string;
  locality?: string;
  region?: string;
  postcode?: string;
  country?: string;
}): string[] {
  const lines: string[] = [];
  if (a.full || a.fullAddress) {
    lines.push((a.full || a.fullAddress) as string);
    return lines;
  }
  if (a.components && a.components.length > 0) {
    const joined = a.components
      .filter((c) => c.kind !== 'separator')
      .map((c) => c.value)
      .filter(Boolean)
      .join(', ');
    if (joined) lines.push(joined);
    return lines;
  }
  const street = a.street?.trim();
  if (street) lines.push(street);
  const cityLine = [a.postcode, a.locality, a.region].filter(Boolean).join(' ').trim();
  if (cityLine) lines.push(cityLine);
  if (a.country?.trim()) lines.push(a.country.trim());
  return lines;
}

export default function ContactDetailScreen() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const t = useLocaleStore((s) => s.t);
  const { contactId } = route.params;

  const contact = useContactsStore((s) => s.contacts.find((c) => c.id === contactId));
  const addressBooks = useContactsStore((s) => s.addressBooks);
  const allContacts = useContactsStore((s) => s.contacts);
  const deleteContact = useContactsStore((s) => s.deleteContact);
  const createContact = useContactsStore((s) => s.createContact);
  const moveContactsToAddressBook = useContactsStore((s) => s.moveContactsToAddressBook);
  const addContactsToGroup = useContactsStore((s) => s.addContactsToGroup);
  const groups = React.useMemo(() => allContacts.filter(isGroup), [allContacts]);

  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [groupPickerOpen, setGroupPickerOpen] = React.useState(false);

  if (!contact) {
    return (
      <SafeAreaView style={styles.container}>
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
          <Text style={styles.headerTitle}>{t('contacts.contact', 'Contact')}</Text>
        </View>
        <View style={styles.missing}>
          <Text style={styles.missingText}>{t('contacts.detail.not_found', 'Contact not found')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const name = getContactDisplayName(contact) || t('contacts.unnamed', 'Unnamed');
  const ctx = (contexts?: Record<string, boolean>): string[] =>
    getActiveContexts(contexts).map((k) => contextLabel(k, t));
  const nickname = contact.nicknames
    ? Object.values(contact.nicknames).map((n) => n.name).filter(Boolean).join(', ')
    : getPrimaryNickname(contact);
  const email = getContactPrimaryEmail(contact);
  const phone = contact.phones ? Object.values(contact.phones)[0]?.number : '';
  const photoUri = getContactPhotoUri(contact);
  const org = getPrimaryOrg(contact);

  const emails = contact.emails ? Object.entries(contact.emails).map(([id, e]) => ({ id, ...e })) : [];
  const phones = contact.phones ? Object.entries(contact.phones).map(([id, p]) => ({ id, ...p })) : [];
  const addresses = contact.addresses ? Object.entries(contact.addresses).map(([id, a]) => ({ id, ...a })) : [];
  const orgs = contact.organizations ? Object.values(contact.organizations) : [];
  const titles = contact.titles ? Object.values(contact.titles) : [];
  const jobTitles = titles.filter((t) => t.kind !== 'role');
  const roles = titles.filter((t) => t.kind === 'role');
  const anniversaries = contact.anniversaries ? Object.values(contact.anniversaries) : [];
  const onlineServices = contact.onlineServices ? Object.values(contact.onlineServices) : [];
  const personalInfo = contact.personalInfo ? Object.values(contact.personalInfo) : [];
  const preferredLanguages = contact.preferredLanguages ? Object.values(contact.preferredLanguages) : [];
  const notes = contact.notes ? Object.values(contact.notes) : [];
  const keywords = getContactKeywords(contact);
  const relatedTo = contact.relatedTo ? Object.entries(contact.relatedTo) : [];
  const cryptoKeys = contact.cryptoKeys ? Object.values(contact.cryptoKeys) : [];
  const bookIds = Object.keys(contact.addressBookIds || {}).filter((k) => contact.addressBookIds[k]);
  const bookNames = bookIds
    .map((id) => addressBooks.find((b) => b.id === id)?.name)
    .filter(Boolean) as string[];
  // On an organization card the org name is already the heading; don't repeat it.
  const subtitleParts = [jobTitles[0]?.name, org === name ? undefined : org].filter(Boolean) as string[];
  const hasGender = !!(contact.speakToAs && (contact.speakToAs.grammaticalGender || contact.speakToAs.pronouns));
  const firstPronoun = contact.speakToAs?.pronouns
    ? Object.values(contact.speakToAs.pronouns)[0]?.pronouns
    : undefined;

  const groupMembersCount = (() => {
    if (!isGroup(contact)) return 0;
    if (contact.members) {
      return Object.keys(contact.members).filter((k) => contact.members![k]).length;
    }
    return 0;
  })();

  const memberContacts = React.useMemo(() => {
    if (!contact.members) return [];
    const memberIds = Object.keys(contact.members).filter((k) => contact.members![k]);
    return memberIds
      .map((mid) => allContacts.find((c) => c.id === mid || c.uid === mid))
      .filter(Boolean) as ContactCard[];
  }, [contact.members, allContacts]);

  const openMail = (addr: string) => {
    navigation.navigate('Compose', {
      prefillTo: [{ name, email: addr }],
    });
  };
  const openTel = (num: string) => {
    Linking.openURL(`tel:${num}`).catch(() => Alert.alert(t('contacts.detail.open_dialer_failed', 'Cannot open dialer')));
  };
  const openSms = (num: string) => {
    Linking.openURL(`sms:${num}`).catch(() => Alert.alert(t('contacts.detail.open_sms_failed', 'Cannot open messaging app')));
  };
  const openMap = (query: string) => {
    const encoded = encodeURIComponent(query);
    Linking.openURL(`https://maps.google.com/?q=${encoded}`).catch(() => Alert.alert(t('contacts.detail.open_maps_failed', 'Cannot open maps')));
  };
  const openUrl = (uri: string) => {
    // Contact data is server-supplied: only hand http(s)/mailto/tel/sms/geo
    // schemes to the OS, never intent:// / file:// / third-party deep links.
    void openExternalUrl(uri).then((opened) => {
      if (!opened) Alert.alert(t('contacts.detail.open_link_failed', 'Cannot open link'));
    });
  };
  const shareValue = (value: string) => {
    Share.share({ message: value }).catch(() => {});
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    try {
      await deleteContact(contact.id);
      navigation.goBack();
    } catch (err) {
      Alert.alert(t('contacts.toast.error_delete', 'Failed to delete contact'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
    }
  };

  const doShare = async () => {
    const vcard = contactToVCard(contact);
    try {
      const safe = name.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40) || 'contact';
      const path = `${FileSystem.cacheDirectory}${safe}.vcf`;
      await FileSystem.writeAsStringAsync(path, vcard);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, {
          mimeType: 'text/vcard',
          UTI: 'public.vcard',
          dialogTitle: t('contacts.detail.share_title', 'Share {name}', { name }),
        });
      } else {
        await Share.share({ message: vcard });
      }
    } catch {
      Share.share({ message: vcard }).catch(() => {});
    }
  };

  const doDuplicate = async () => {
    const targetBookId = bookIds[0] || addressBooks[0]?.id;
    if (!targetBookId) {
      Alert.alert(
        t('contacts.detail.no_address_book', 'No address book'),
        t('contacts.detail.duplicate_no_book', 'Cannot duplicate without an address book.'),
      );
      return;
    }
    // Drop the UID too: the copy gets a fresh one on create, otherwise group
    // membership by uid matches both cards and CardDAV sees two cards with one UID.
    const {
      id: _id,
      uid: _uid,
      originalId: _originalId,
      accountId: _accountId,
      accountName: _accountName,
      isShared: _isShared,
      addressBookIds: _abIds,
      created: _created,
      updated: _updated,
      ...rest
    } = contact;
    const baseName =
      t('contacts.detail.copy_name', '{name} (Copy)', { name: rest.name?.full || name });
    const draft: Partial<ContactCard> = {
      ...rest,
      name: rest.name ? { ...rest.name, full: baseName } : { full: baseName },
    };
    try {
      const created = await createContact(draft, targetBookId);
      navigation.replace('ContactDetail', { contactId: created.id });
    } catch (err) {
      Alert.alert(t('contacts.detail.duplicate_failed', 'Duplicate failed'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
    }
  };

  const doMove = async (bookId: string) => {
    setMoveOpen(false);
    try {
      await moveContactsToAddressBook([contact.id], bookId);
    } catch (err) {
      Alert.alert(t('contacts.address_books.move_failed', 'Failed to move contact'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
    }
  };

  const moreItems = [
    !isGroup(contact) && {
      icon: <Copy size={16} color={c.text} />,
      label: t('contacts.context_menu.duplicate', 'Duplicate'),
      onPress: () => { void doDuplicate(); },
    },
    !isGroup(contact) && {
      icon: <Users size={16} color={c.text} />,
      label: t('contacts.context_menu.add_to_group', 'Add to group'),
      onPress: () => setGroupPickerOpen(true),
    },
    addressBooks.length > 0 && {
      icon: <FolderInput size={16} color={c.text} />,
      label: t('contacts.bulk.move_to_address_book', 'Move to address book'),
      onPress: () => setMoveOpen(true),
    },
    {
      icon: <Share2 size={16} color={c.text} />,
      label: t('contacts.context_menu.export_vcard', 'Export as vCard'),
      onPress: () => { void doShare(); },
    },
    { separator: true },
    {
      icon: <Trash2 size={16} color={c.error} />,
      label: t('contacts.context_menu.delete', 'Delete'),
      onPress: () => setConfirmDelete(true),
      destructive: true,
    },
  ].filter(Boolean) as MoreItem[];

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
        <Text style={styles.headerTitle} numberOfLines={1}>
          {isGroup(contact) ? t('contacts.group', 'Group') : t('contacts.contact', 'Contact')}
        </Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => navigation.navigate('ContactForm', { contactId: contact.id })}
            style={styles.headerBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('contacts.context_menu.edit', 'Edit')}
          >
            <Pencil size={18} color={c.text} />
          </Pressable>
          <Pressable
            onPress={() => setMoreOpen(true)}
            style={styles.headerBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('contacts.detail.more_actions', 'More actions')}
          >
            <MoreHorizontal size={20} color={c.text} />
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.hero}>
          {photoUri ? (
            <Image source={{ uri: photoUri }} style={styles.heroPhoto} />
          ) : (
            <SenderAvatar name={name} email={email} size={96} />
          )}
          <Text style={styles.heroName}>{name}</Text>
          {!!nickname && <Text style={styles.heroNickname}>“{nickname}”</Text>}
          {subtitleParts.length > 0 && (
            <Text style={styles.heroSubtitle}>{subtitleParts.join(' · ')}</Text>
          )}
          {isGroup(contact) && groupMembersCount > 0 && (
            <Text style={styles.heroSubtitle}>
              {t('contacts.groups.member_count', '{count, plural, =0 {No members} one {1 member} other {# members}}', { count: groupMembersCount })}
            </Text>
          )}
        </View>

        <View style={styles.quickActions}>
          {!!email && (
            <QuickAction icon={<Mail size={18} color={c.primary} />} label={t('contacts.detail.email_default_label', 'Email')} onPress={() => openMail(email)} />
          )}
          {!!phone && (
            <QuickAction icon={<Phone size={18} color={c.primary} />} label={t('contacts.context_menu.call', 'Call')} onPress={() => openTel(phone)} />
          )}
          {!!phone && (
            <QuickAction icon={<MessageSquare size={18} color={c.primary} />} label={t('contacts.detail.sms', 'SMS')} onPress={() => openSms(phone)} />
          )}
          <QuickAction
            icon={<Share2 size={18} color={c.primary} />}
            label={t('contacts.detail.share', 'Share')}
            onPress={() => { void doShare(); }}
          />
        </View>

        <View style={styles.sections}>
          {emails.length > 0 && (
            <Section icon={<Mail size={16} color={c.textMuted} />} label={t('contacts.detail.email_default_label', 'Email')}>
              {emails.map((e) => {
                const ctxLabel =
                  e.label || ctx(e.contexts).join(', ') || undefined;
                return (
                  <DetailRow key={e.id} label={ctxLabel}>
                    <Pressable
                      onPress={() => openMail(e.address)}
                      onLongPress={() => shareValue(e.address)}
                    >
                      <Text style={styles.linkText}>{e.address}</Text>
                    </Pressable>
                  </DetailRow>
                );
              })}
            </Section>
          )}

          {phones.length > 0 && (
            <Section icon={<Phone size={16} color={c.textMuted} />} label={t('contacts.detail.phone_default_label', 'Phone')}>
              {phones.map((p) => {
                const features = getPhoneFeatures(p.features).map((f) => phoneFeatureLabel(f, t));
                const labelParts = [
                  p.label,
                  ...ctx(p.contexts),
                  ...features,
                ].filter(Boolean) as string[];
                return (
                  <DetailRow key={p.id} label={labelParts.length ? labelParts.join(' · ') : undefined}>
                    <View style={styles.phoneRow}>
                      <Pressable
                        onPress={() => openTel(p.number)}
                        onLongPress={() => shareValue(p.number)}
                        style={{ flex: 1 }}
                      >
                        <Text style={styles.linkText}>{p.number}</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => openSms(p.number)}
                        hitSlop={6}
                        style={styles.smallActionBtn}
                        accessibilityRole="button"
                        accessibilityLabel={t('contacts.detail.sms', 'SMS')}
                      >
                        <MessageSquare size={14} color={c.textMuted} />
                      </Pressable>
                    </View>
                  </DetailRow>
                );
              })}
            </Section>
          )}

          {addresses.length > 0 && (
            <Section icon={<MapPin size={16} color={c.textMuted} />} label={t('contacts.detail.address_default_label', 'Address')}>
              {addresses.map((a) => {
                const lines = buildAddressLines(a);
                const formatted = formatAddress(a);
                const ctxLabel = ctx(a.contexts).join(', ') || a.label;
                return (
                  <DetailRow key={a.id} label={ctxLabel}>
                    <Pressable
                      onPress={() => formatted && openMap(formatted)}
                      onLongPress={() => formatted && shareValue(formatted)}
                    >
                      {lines.map((line, idx) => (
                        <Text key={idx} style={styles.value}>{line}</Text>
                      ))}
                      {!!a.timeZone && (
                        <Text style={styles.subValue}>{t('contacts.detail.timezone_value', 'Timezone: {zone}', { zone: a.timeZone })}</Text>
                      )}
                    </Pressable>
                  </DetailRow>
                );
              })}
            </Section>
          )}

          {(orgs.length > 0 || titles.length > 0) && (
            <Section icon={<Building size={16} color={c.textMuted} />} label={t('contacts.detail.section_work', 'Work')}>
              {orgs.map((o, i) => (
                <DetailRow key={`org-${i}`} label={t('contacts.detail.organization_label', 'Organization')}>
                  <Text style={styles.value}>{o.name}</Text>
                  {!!(o.units && o.units.length) && (
                    <Text style={styles.subValue}>{o.units.map((u) => u.name).join(', ')}</Text>
                  )}
                </DetailRow>
              ))}
              {jobTitles.map((tl, i) => (
                <DetailRow key={`title-${i}`} label={t('contacts.detail.title_label', 'Title')}>
                  <Text style={styles.value}>{tl.name}</Text>
                </DetailRow>
              ))}
              {roles.map((r, i) => (
                <DetailRow key={`role-${i}`} label={t('contacts.detail.role_label', 'Role')}>
                  <Text style={styles.value}>{r.name}</Text>
                </DetailRow>
              ))}
            </Section>
          )}

          {(anniversaries.length > 0 || hasGender || preferredLanguages.length > 0 || personalInfo.length > 0) && (
            <Section icon={<Heart size={16} color={c.textMuted} />} label={t('contacts.detail.section_personal', 'Personal')}>
              {anniversaries.map((a, i) => {
                const years = getCompletedYears(a.date);
                const suffix =
                  years !== null
                    ? a.kind === 'birth'
                      ? ` · ${t('contacts.detail.age_years', '{count, plural, one {1 year old} other {# years old}}', { count: years })}`
                      : ` · ${t('contacts.detail.years_since', '{count, plural, one {1 year} other {# years}}', { count: years })}`
                    : '';
                const kindLabel =
                  a.kind === 'birth' ? t('contacts.detail.anniversary_birth', 'Birthday')
                  : a.kind === 'wedding' ? t('contacts.detail.anniversary_wedding', 'Anniversary')
                  : a.kind === 'death' ? t('contacts.form.anniversary_death', 'Memorial')
                  : t('contacts.detail.anniversary_other', 'Other');
                return (
                  <DetailRow key={`an-${i}`} label={kindLabel} icon={<Cake size={14} color={c.textMuted} />}>
                    <Text style={styles.value}>{formatPartialDate(a.date)}{suffix}</Text>
                  </DetailRow>
                );
              })}
              {hasGender && (
                <DetailRow label={t('contacts.detail.gender', 'Gender')} icon={<UserCircle size={14} color={c.textMuted} />}>
                  <Text style={styles.value}>
                    {[
                      contact.speakToAs?.grammaticalGender && genderLabel(contact.speakToAs.grammaticalGender, t),
                      firstPronoun,
                    ].filter(Boolean).join(' · ')}
                  </Text>
                </DetailRow>
              )}
              {preferredLanguages.map((lang, i) => (
                <DetailRow
                  key={`lg-${i}`}
                  label={ctx(lang.contexts).join(', ') || t('contacts.detail.language_label', 'Language')}
                  icon={<Languages size={14} color={c.textMuted} />}
                >
                  <Text style={styles.value}>{lang.language}</Text>
                </DetailRow>
              ))}
              {personalInfo.map((pi, i) => (
                <DetailRow
                  key={`pi-${i}`}
                  label={personalInfoLabel(pi.kind, pi.level, t)}
                >
                  <Text style={styles.value}>{pi.value}</Text>
                </DetailRow>
              ))}
            </Section>
          )}

          {onlineServices.length > 0 && (
            <Section icon={<Globe size={16} color={c.textMuted} />} label={t('contacts.detail.online_service_default_label', 'Online')}>
              {onlineServices.map((s, i) => {
                const labelParts = [s.service, ...ctx(s.contexts)].filter(Boolean) as string[];
                const isHttp = typeof s.uri === 'string' && /^https?:/i.test(s.uri);
                return (
                  <DetailRow key={`os-${i}`} label={labelParts.join(' · ') || undefined}>
                    <Pressable
                      onPress={() => isHttp && openUrl(s.uri as string)}
                      onLongPress={() => shareValue((s.user || s.uri || '') as string)}
                    >
                      <Text style={isHttp ? styles.linkText : styles.value}>{s.user || s.uri}</Text>
                    </Pressable>
                  </DetailRow>
                );
              })}
            </Section>
          )}

          {(contact.calendarUri || contact.schedulingUri || contact.freeBusyUri) && (
            <Section icon={<CalendarIcon size={16} color={c.textMuted} />} label={t('contacts.detail.calendar', 'Calendar')}>
              {!!contact.calendarUri && (
                <DetailRow label={t('contacts.detail.calendar_uri', 'Calendar URL')}>
                  <Pressable onPress={() => openUrl(contact.calendarUri!)}>
                    <Text style={[styles.value, styles.linkText]} numberOfLines={2}>{contact.calendarUri}</Text>
                  </Pressable>
                </DetailRow>
              )}
              {!!contact.schedulingUri && (
                <DetailRow label={t('contacts.detail.scheduling_uri', 'Scheduling URL')}>
                  <Pressable onPress={() => openUrl(contact.schedulingUri!)}>
                    <Text style={[styles.value, styles.linkText]} numberOfLines={2}>{contact.schedulingUri}</Text>
                  </Pressable>
                </DetailRow>
              )}
              {!!contact.freeBusyUri && (
                <DetailRow label={t('contacts.detail.freebusy_uri', 'Free/Busy URL')}>
                  <Pressable onPress={() => openUrl(contact.freeBusyUri!)}>
                    <Text style={[styles.value, styles.linkText]} numberOfLines={2}>{contact.freeBusyUri}</Text>
                  </Pressable>
                </DetailRow>
              )}
            </Section>
          )}

          {cryptoKeys.length > 0 && (
            <Section icon={<KeyRound size={16} color={c.textMuted} />} label={t('contacts.detail.crypto_keys', 'Crypto Keys')}>
              {cryptoKeys.map((key, i) => (
                <DetailRow key={`ck-${i}`} label={ctx(key.contexts).join(', ') || key.mediaType}>
                  <Text style={styles.value} numberOfLines={3}>
                    {typeof key.uri === 'string'
                      ? `${key.uri.substring(0, 80)}${key.uri.length > 80 ? '…' : ''}`
                      : String(key.uri ?? '')}
                  </Text>
                </DetailRow>
              ))}
            </Section>
          )}

          {keywords.length > 0 && (
            <Section icon={<Tag size={16} color={c.textMuted} />} label={t('contacts.detail.categories', 'Categories')}>
              <View style={styles.chipRow}>
                {keywords.map((kw) => (
                  <View key={kw} style={styles.tagChip}>
                    <Text style={styles.tagChipText}>{kw}</Text>
                  </View>
                ))}
              </View>
            </Section>
          )}

          {relatedTo.length > 0 && (
            <Section icon={<Users size={16} color={c.textMuted} />} label={t('contacts.detail.related_default_label', 'Related')}>
              {relatedTo.map(([uri, rel], i) => {
                const relType = rel.relation
                  ? Object.keys(rel.relation).find((k) => rel.relation![k])
                  : undefined;
                return (
                  <DetailRow key={`rel-${i}`} label={relType}>
                    <Text style={styles.value} numberOfLines={2}>{uri}</Text>
                  </DetailRow>
                );
              })}
            </Section>
          )}

          {memberContacts.length > 0 && (
            <Section icon={<Users size={16} color={c.textMuted} />} label={t('contacts.groups.members_with_count', 'Members ({count})', { count: memberContacts.length })}>
              {memberContacts.map((m) => (
                <Pressable
                  key={m.id}
                  style={styles.memberRow}
                  onPress={() => navigation.push('ContactDetail', { contactId: m.id })}
                >
                  <SenderAvatar
                    name={getContactDisplayName(m)}
                    email={getContactPrimaryEmail(m)}
                    size={32}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.memberName} numberOfLines={1}>{getContactDisplayName(m)}</Text>
                    {!!getContactPrimaryEmail(m) && (
                      <Text style={styles.memberEmail} numberOfLines={1}>{getContactPrimaryEmail(m)}</Text>
                    )}
                  </View>
                </Pressable>
              ))}
            </Section>
          )}

          {notes.length > 0 && (
            <Section icon={<FileText size={16} color={c.textMuted} />} label={t('contacts.detail.notes', 'Notes')}>
              {notes.map((n, i) => (
                <Text key={i} style={styles.noteText}>{n.note}</Text>
              ))}
            </Section>
          )}

          {bookNames.length > 0 && (
            <Section icon={<BookUser size={16} color={c.textMuted} />} label={t('contacts.address_books.address_book', 'Address Book')}>
              {bookNames.map((n, i) => (
                <Text key={i} style={styles.value}>{n}</Text>
              ))}
            </Section>
          )}

          {!isGroup(contact) && <ContactActivity contact={contact} />}

          {(contact.created || contact.updated) && (
            <View style={styles.metaRow}>
              <Clock size={12} color={c.textMuted} />
              <Text style={styles.metaText}>
                {contact.created && t('contacts.detail.created_on', 'Created {date}', { date: formatTimestamp(contact.created) })}
                {contact.created && contact.updated && '   ·   '}
                {contact.updated && t('contacts.detail.updated_on', 'Updated {date}', { date: formatTimestamp(contact.updated) })}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      <Dialog
        visible={confirmDelete}
        title={isGroup(contact)
          ? t('contacts.groups.delete_confirm_title', 'Delete group')
          : t('contacts.delete_confirm_title', 'Delete contact')}
        message={t('files.delete_confirm_message', 'Are you sure you want to delete "{name}"? This cannot be undone.', { name })}
        variant="destructive"
        confirmText={t('contacts.context_menu.delete', 'Delete')}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />

      <MoreActionsSheet
        visible={moreOpen}
        items={moreItems}
        onClose={() => setMoreOpen(false)}
      />

      <MoreActionsSheet
        visible={groupPickerOpen}
        onClose={() => setGroupPickerOpen(false)}
        items={[
          ...groups.map((g): MoreItem => ({
            icon: <Users size={16} color={c.text} />,
            label: getContactDisplayName(g) || t('contacts.group', 'Group'),
            onPress: () => {
              addContactsToGroup(g.id, [contact.id]).catch((err) => {
                Alert.alert(t('contacts.detail.add_to_group_failed', 'Add to group failed'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
              });
            },
          })),
          ...(groups.length > 0 ? [{ separator: true } as MoreItem] : []),
          {
            icon: <Plus size={16} color={c.text} />,
            label: t('contacts.groups.create_ellipsis', 'New group…'),
            onPress: () => navigation.navigate('ContactForm', { asGroup: true, memberIds: [contact.id] }),
          },
        ]}
      />

      <AddressBookPickerSheet
        visible={moveOpen}
        onClose={() => setMoveOpen(false)}
        currentBookId={bookIds[0] ?? null}
        onPick={(id) => { void doMove(id); }}
      />
    </SafeAreaView>
  );
}

type MoreItem =
  | { icon: React.ReactNode; label: string; onPress: () => void; destructive?: boolean; separator?: false }
  | { separator: true };

function MoreActionsSheet({
  visible, items, onClose,
}: {
  visible: boolean;
  items: MoreItem[];
  onClose: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const slideY = React.useRef(new Animated.Value(Dimensions.get('window').height)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: Dimensions.get('window').height, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, overlayOpacity]);

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <Animated.View style={[styles.sheetOverlay, { opacity: overlayOpacity }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[styles.sheet, { transform: [{ translateY: slideY }] }]}>
        <SafeAreaView edges={['bottom']}>
          <View style={styles.handleHit}>
            <View style={styles.handle} />
          </View>
          {items.map((item, i) => {
            if ('separator' in item && item.separator) {
              return <View key={`sep-${i}`} style={styles.sheetSeparator} />;
            }
            const it = item as Exclude<MoreItem, { separator: true }>;
            return (
              <Pressable
                key={i}
                onPress={() => { it.onPress(); onClose(); }}
                accessibilityRole="button"
                style={({ pressed }) => [styles.sheetItem, pressed && styles.sheetItemPressed]}
              >
                {it.icon}
                <Text
                  style={[styles.sheetItemLabel, it.destructive && styles.sheetItemLabelDestructive]}
                >
                  {it.label}
                </Text>
              </Pressable>
            );
          })}
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

function Section({
  icon, label, children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionIcon}>{icon}</View>
        <Text style={styles.sectionLabel}>{label}</Text>
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function DetailRow({
  label, icon, children,
}: {
  label?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailLabelRow}>
        {!!icon && <View style={{ width: 14 }}>{icon}</View>}
        {!!label && <Text style={styles.detailLabel}>{label}</Text>}
      </View>
      <View>{children}</View>
    </View>
  );
}

function QuickAction({
  icon, label, onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      style={({ pressed }) => [styles.quickBtn, pressed && styles.quickBtnPressed]}
      onPress={onPress}
      accessibilityRole="button"
    >
      <View style={styles.quickIcon}>{icon}</View>
      <Text style={styles.quickLabel}>{label}</Text>
    </Pressable>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    scrollContent: { paddingBottom: spacing.xxxl * 2 },

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
    headerTitle: { ...typography.h3, color: c.text, flex: 1, marginLeft: spacing.xs },
    headerActions: { flexDirection: 'row', gap: spacing.xs },

    hero: {
      alignItems: 'center',
      paddingVertical: spacing.xl,
      paddingHorizontal: spacing.lg,
      gap: 4,
    },
    heroPhoto: {
      width: 96,
      height: 96,
      borderRadius: 48,
      backgroundColor: c.surface,
    },
    heroName: { ...typography.h2, color: c.text, textAlign: 'center', marginTop: spacing.sm },
    heroNickname: { ...typography.body, color: c.textSecondary, fontStyle: 'italic', textAlign: 'center' },
    heroSubtitle: { ...typography.body, color: c.textSecondary, textAlign: 'center' },

    quickActions: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.lg,
    },
    quickBtn: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: spacing.md,
      borderRadius: radius.md,
      backgroundColor: c.surface,
      gap: spacing.xs,
    },
    quickBtnPressed: { backgroundColor: c.surfaceHover },
    quickIcon: {
      width: 32, height: 32,
      alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.full,
      backgroundColor: c.primaryBg,
    },
    quickLabel: { ...typography.caption, color: c.textSecondary },

    sections: {
      paddingHorizontal: spacing.lg,
      gap: spacing.lg,
    },

    section: { gap: spacing.sm },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    sectionIcon: { width: 16 },
    sectionLabel: {
      ...typography.bodyMedium,
      color: c.textSecondary,
      textTransform: 'uppercase',
      fontSize: 11,
      letterSpacing: 0.6,
    },
    sectionBody: {
      paddingLeft: spacing.lg + spacing.xs,
      gap: spacing.md,
    },

    detailRow: { gap: 2 },
    detailLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    detailLabel: {
      ...typography.caption,
      color: c.textMuted,
      textTransform: 'lowercase',
    },
    value: { ...typography.body, color: c.text },
    subValue: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    linkText: { ...typography.body, color: c.primary },
    noteText: { ...typography.body, color: c.text, lineHeight: 20 },

    phoneRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    smallActionBtn: {
      width: 28, height: 28,
      alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.full,
      backgroundColor: c.surface,
    },

    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    tagChip: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.full,
      backgroundColor: c.primaryBg,
    },
    tagChipText: { ...typography.caption, color: c.primary },

    memberRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: 4,
    },
    memberName: { ...typography.body, color: c.text },
    memberEmail: { ...typography.caption, color: c.textMuted },

    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingTop: spacing.md,
      paddingHorizontal: spacing.xs,
    },
    metaText: { ...typography.small, color: c.textMuted },

    missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    missingText: { ...typography.body, color: c.textMuted },

    sheetOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    sheet: {
      position: 'absolute',
      left: 0, right: 0, bottom: 0,
      backgroundColor: c.background,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      paddingBottom: spacing.sm,
    },
    handleHit: { alignItems: 'center', paddingTop: spacing.xs, paddingBottom: spacing.sm },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.surfaceActive },
    sheetItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    sheetItemPressed: { backgroundColor: c.surfaceHover },
    sheetItemLabel: { ...typography.body, color: c.text },
    sheetItemLabelDestructive: { color: c.error },
    sheetSeparator: { height: 1, backgroundColor: c.borderLight, marginVertical: 4 },
  });
}
