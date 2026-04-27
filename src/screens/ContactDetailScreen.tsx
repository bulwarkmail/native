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
  Clock, KeyRound,
} from 'lucide-react-native';
import type { RootStackParamList } from '../navigation/types';
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
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ContactDetail'>;
type Route = RouteProp<RootStackParamList, 'ContactDetail'>;

function formatTimestamp(s: string | undefined): string {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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
  const { contactId } = route.params;

  const contact = useContactsStore((s) => s.contacts.find((c) => c.id === contactId));
  const addressBooks = useContactsStore((s) => s.addressBooks);
  const allContacts = useContactsStore((s) => s.contacts);
  const deleteContact = useContactsStore((s) => s.deleteContact);
  const createContact = useContactsStore((s) => s.createContact);

  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);

  if (!contact) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={() => navigation.goBack()} style={styles.headerBtn} hitSlop={8}>
            <ArrowLeft size={22} color={c.text} />
          </Pressable>
          <Text style={styles.headerTitle}>Contact</Text>
        </View>
        <View style={styles.missing}>
          <Text style={styles.missingText}>Contact not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const name = getContactDisplayName(contact) || 'Unnamed';
  const nickname = getPrimaryNickname(contact);
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
  const subtitleParts = [jobTitles[0]?.name, org].filter(Boolean) as string[];
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
    Linking.openURL(`tel:${num}`).catch(() => Alert.alert('Cannot open dialer'));
  };
  const openSms = (num: string) => {
    Linking.openURL(`sms:${num}`).catch(() => Alert.alert('Cannot open messaging app'));
  };
  const openMap = (query: string) => {
    const encoded = encodeURIComponent(query);
    Linking.openURL(`https://maps.google.com/?q=${encoded}`).catch(() => Alert.alert('Cannot open maps'));
  };
  const openUrl = (uri: string) => {
    Linking.openURL(uri).catch(() => Alert.alert('Cannot open link'));
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
      Alert.alert('Delete failed', err instanceof Error ? err.message : 'Unknown error');
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
          dialogTitle: `Share ${name}`,
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
      Alert.alert('No address book', 'Cannot duplicate without an address book.');
      return;
    }
    const {
      id: _id,
      addressBookIds: _abIds,
      created: _created,
      updated: _updated,
      ...rest
    } = contact;
    const baseName =
      (rest.name?.full ? `${rest.name.full} (Copy)` : null) ??
      `${name} (Copy)`;
    const draft: Partial<ContactCard> = {
      ...rest,
      name: rest.name ? { ...rest.name, full: baseName } : { full: baseName },
    };
    try {
      const created = await createContact(draft, targetBookId);
      navigation.replace('ContactDetail', { contactId: created.id });
    } catch (err) {
      Alert.alert('Duplicate failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const moreItems = [
    !isGroup(contact) && {
      icon: <Copy size={16} color={c.text} />,
      label: 'Duplicate',
      onPress: () => { void doDuplicate(); },
    },
    {
      icon: <Share2 size={16} color={c.text} />,
      label: 'Export vCard',
      onPress: () => { void doShare(); },
    },
    { separator: true },
    {
      icon: <Trash2 size={16} color={c.error} />,
      label: 'Delete',
      onPress: () => setConfirmDelete(true),
      destructive: true,
    },
  ].filter(Boolean) as MoreItem[];

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.headerBtn} hitSlop={8}>
          <ArrowLeft size={22} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {isGroup(contact) ? 'Group' : 'Contact'}
        </Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => navigation.navigate('ContactForm', { contactId: contact.id })}
            style={styles.headerBtn}
            hitSlop={8}
          >
            <Pencil size={18} color={c.text} />
          </Pressable>
          <Pressable
            onPress={() => setMoreOpen(true)}
            style={styles.headerBtn}
            hitSlop={8}
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
            <Text style={styles.heroSubtitle}>{groupMembersCount} member{groupMembersCount === 1 ? '' : 's'}</Text>
          )}
        </View>

        <View style={styles.quickActions}>
          {!!email && (
            <QuickAction icon={<Mail size={18} color={c.primary} />} label="Email" onPress={() => openMail(email)} />
          )}
          {!!phone && (
            <QuickAction icon={<Phone size={18} color={c.primary} />} label="Call" onPress={() => openTel(phone)} />
          )}
          {!!phone && (
            <QuickAction icon={<MessageSquare size={18} color={c.primary} />} label="SMS" onPress={() => openSms(phone)} />
          )}
          <QuickAction
            icon={<Share2 size={18} color={c.primary} />}
            label="Share"
            onPress={() => { void doShare(); }}
          />
        </View>

        <View style={styles.sections}>
          {emails.length > 0 && (
            <Section icon={<Mail size={16} color={c.textMuted} />} label="Email">
              {emails.map((e) => {
                const ctxLabel =
                  e.label || getActiveContexts(e.contexts).join(', ') || undefined;
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
            <Section icon={<Phone size={16} color={c.textMuted} />} label="Phone">
              {phones.map((p) => {
                const features = getPhoneFeatures(p.features);
                const labelParts = [
                  p.label,
                  ...getActiveContexts(p.contexts),
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
                      <Pressable onPress={() => openSms(p.number)} hitSlop={6} style={styles.smallActionBtn}>
                        <MessageSquare size={14} color={c.textMuted} />
                      </Pressable>
                    </View>
                  </DetailRow>
                );
              })}
            </Section>
          )}

          {addresses.length > 0 && (
            <Section icon={<MapPin size={16} color={c.textMuted} />} label="Address">
              {addresses.map((a) => {
                const lines = buildAddressLines(a);
                const formatted = formatAddress(a);
                const ctxLabel = getActiveContexts(a.contexts).join(', ') || a.label;
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
                        <Text style={styles.subValue}>Timezone: {a.timeZone}</Text>
                      )}
                    </Pressable>
                  </DetailRow>
                );
              })}
            </Section>
          )}

          {(orgs.length > 0 || titles.length > 0) && (
            <Section icon={<Building size={16} color={c.textMuted} />} label="Work">
              {orgs.map((o, i) => (
                <DetailRow key={`org-${i}`} label="Organization">
                  <Text style={styles.value}>{o.name}</Text>
                  {!!(o.units && o.units.length) && (
                    <Text style={styles.subValue}>{o.units.map((u) => u.name).join(', ')}</Text>
                  )}
                </DetailRow>
              ))}
              {jobTitles.map((tl, i) => (
                <DetailRow key={`title-${i}`} label="Title">
                  <Text style={styles.value}>{tl.name}</Text>
                </DetailRow>
              ))}
              {roles.map((r, i) => (
                <DetailRow key={`role-${i}`} label="Role">
                  <Text style={styles.value}>{r.name}</Text>
                </DetailRow>
              ))}
            </Section>
          )}

          {(anniversaries.length > 0 || hasGender || preferredLanguages.length > 0 || personalInfo.length > 0) && (
            <Section icon={<Heart size={16} color={c.textMuted} />} label="Personal">
              {anniversaries.map((a, i) => {
                const years = getCompletedYears(a.date);
                const suffix =
                  years !== null
                    ? a.kind === 'birth'
                      ? ` · age ${years}`
                      : ` · ${years} year${years === 1 ? '' : 's'} ago`
                    : '';
                const kindLabel =
                  a.kind === 'birth' ? 'Birthday'
                  : a.kind === 'wedding' ? 'Anniversary'
                  : a.kind === 'death' ? 'Memorial'
                  : 'Other';
                return (
                  <DetailRow key={`an-${i}`} label={kindLabel} icon={<Cake size={14} color={c.textMuted} />}>
                    <Text style={styles.value}>{formatPartialDate(a.date)}{suffix}</Text>
                  </DetailRow>
                );
              })}
              {hasGender && (
                <DetailRow label="Gender" icon={<UserCircle size={14} color={c.textMuted} />}>
                  <Text style={styles.value}>
                    {[contact.speakToAs?.grammaticalGender, firstPronoun].filter(Boolean).join(' · ')}
                  </Text>
                </DetailRow>
              )}
              {preferredLanguages.map((lang, i) => (
                <DetailRow
                  key={`lg-${i}`}
                  label={getActiveContexts(lang.contexts).join(', ') || 'Language'}
                  icon={<Languages size={14} color={c.textMuted} />}
                >
                  <Text style={styles.value}>{lang.language}</Text>
                </DetailRow>
              ))}
              {personalInfo.map((pi, i) => (
                <DetailRow
                  key={`pi-${i}`}
                  label={`${pi.kind}${pi.level ? ` · ${pi.level}` : ''}`}
                >
                  <Text style={styles.value}>{pi.value}</Text>
                </DetailRow>
              ))}
            </Section>
          )}

          {onlineServices.length > 0 && (
            <Section icon={<Globe size={16} color={c.textMuted} />} label="Online">
              {onlineServices.map((s, i) => {
                const labelParts = [s.service, ...getActiveContexts(s.contexts)].filter(Boolean) as string[];
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
            <Section icon={<CalendarIcon size={16} color={c.textMuted} />} label="Calendar">
              {!!contact.calendarUri && (
                <DetailRow label="Calendar">
                  <Pressable onPress={() => openUrl(contact.calendarUri!)}>
                    <Text style={[styles.value, styles.linkText]} numberOfLines={2}>{contact.calendarUri}</Text>
                  </Pressable>
                </DetailRow>
              )}
              {!!contact.schedulingUri && (
                <DetailRow label="Scheduling">
                  <Pressable onPress={() => openUrl(contact.schedulingUri!)}>
                    <Text style={[styles.value, styles.linkText]} numberOfLines={2}>{contact.schedulingUri}</Text>
                  </Pressable>
                </DetailRow>
              )}
              {!!contact.freeBusyUri && (
                <DetailRow label="Free/Busy">
                  <Pressable onPress={() => openUrl(contact.freeBusyUri!)}>
                    <Text style={[styles.value, styles.linkText]} numberOfLines={2}>{contact.freeBusyUri}</Text>
                  </Pressable>
                </DetailRow>
              )}
            </Section>
          )}

          {cryptoKeys.length > 0 && (
            <Section icon={<KeyRound size={16} color={c.textMuted} />} label="Crypto Keys">
              {cryptoKeys.map((key, i) => (
                <DetailRow key={`ck-${i}`} label={getActiveContexts(key.contexts).join(', ') || key.mediaType}>
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
            <Section icon={<Tag size={16} color={c.textMuted} />} label="Categories">
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
            <Section icon={<Users size={16} color={c.textMuted} />} label="Related">
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
            <Section icon={<Users size={16} color={c.textMuted} />} label={`Members (${memberContacts.length})`}>
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
            <Section icon={<FileText size={16} color={c.textMuted} />} label="Notes">
              {notes.map((n, i) => (
                <Text key={i} style={styles.noteText}>{n.note}</Text>
              ))}
            </Section>
          )}

          {bookNames.length > 0 && (
            <Section icon={<BookUser size={16} color={c.textMuted} />} label="Address Book">
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
                {contact.created && `Created ${formatTimestamp(contact.created)}`}
                {contact.created && contact.updated && '   ·   '}
                {contact.updated && `Updated ${formatTimestamp(contact.updated)}`}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      <Dialog
        visible={confirmDelete}
        title={isGroup(contact) ? 'Delete group' : 'Delete contact'}
        message={`Are you sure you want to delete "${name}"? This cannot be undone.`}
        variant="destructive"
        confirmText="Delete"
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />

      <MoreActionsSheet
        visible={moreOpen}
        items={moreItems}
        onClose={() => setMoreOpen(false)}
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
    <Pressable style={({ pressed }) => [styles.quickBtn, pressed && styles.quickBtnPressed]} onPress={onPress}>
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
