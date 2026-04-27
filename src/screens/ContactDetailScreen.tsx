import React from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Linking, Alert, Image, Share,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ArrowLeft, Edit2, Trash2, Mail, Phone, MessageSquare, Share2, MapPin,
  Building, Briefcase, Cake, Heart, Globe, Tag, Users, FileText, BookUser,
  Copy,
} from 'lucide-react-native';
import type { RootStackParamList } from '../navigation/types';
import type { ContactCard } from '../api/types';
import { useContactsStore } from '../stores/contacts-store';
import {
  getContactDisplayName, getContactPrimaryEmail, getContactPhotoUri,
  getPrimaryOrg, getPrimaryTitle, formatPartialDate, formatAddress,
  getContactKeywords, isGroup,
} from '../lib/contact-utils';
import { contactToVCard } from '../lib/vcard';
import SenderAvatar from '../components/SenderAvatar';
import Dialog from '../components/Dialog';
import { ContactActivity } from '../components/contacts/ContactActivity';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ContactDetail'>;
type Route = RouteProp<RootStackParamList, 'ContactDetail'>;

const CATEGORY_COLORS: Record<string, string> = {
  contact: c.primary,
  work: c.calendar.orange,
  location: c.calendar.green,
  personal: c.calendar.pink,
  digital: c.calendar.teal,
  notes: c.calendar.purple,
};

function Section({
  icon, title, category = 'contact', children,
}: {
  icon: React.ReactNode;
  title: string;
  category?: keyof typeof CATEGORY_COLORS;
  children: React.ReactNode;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const accent = CATEGORY_COLORS[category] || c.primary;
  return (
    <View style={[styles.section, { borderLeftColor: accent }]}>
      <View style={styles.sectionHeader}>
        {icon}
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function ContextChips({ contexts }: { contexts?: Record<string, boolean> }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  if (!contexts) return null;
  const keys = Object.keys(contexts).filter((k) => contexts[k]);
  if (keys.length === 0) return null;
  return (
    <View style={styles.chipRow}>
      {keys.map((k) => (
        <View key={k} style={styles.contextChip}>
          <Text style={styles.contextChipText}>{k}</Text>
        </View>
      ))}
    </View>
  );
}

export default function ContactDetailScreen() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { contactId } = route.params;

  const contact = useContactsStore((s) => s.contacts.find((c) => c.id === contactId));
  const addressBooks = useContactsStore((s) => s.addressBooks);
  const deleteContact = useContactsStore((s) => s.deleteContact);
  const createContact = useContactsStore((s) => s.createContact);

  const [confirmDelete, setConfirmDelete] = React.useState(false);

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
  const email = getContactPrimaryEmail(contact);
  const phone = contact.phones ? Object.values(contact.phones)[0]?.number : '';
  const photoUri = getContactPhotoUri(contact);
  const org = getPrimaryOrg(contact);
  const title = getPrimaryTitle(contact);

  const emails = contact.emails ? Object.entries(contact.emails).map(([id, e]) => ({ id, ...e })) : [];
  const phones = contact.phones ? Object.entries(contact.phones).map(([id, p]) => ({ id, ...p })) : [];
  const addresses = contact.addresses ? Object.entries(contact.addresses).map(([id, a]) => ({ id, ...a })) : [];
  const orgs = contact.organizations ? Object.values(contact.organizations) : [];
  const titles = contact.titles ? Object.values(contact.titles) : [];
  const anniversaries = contact.anniversaries ? Object.values(contact.anniversaries) : [];
  const onlineServices = contact.onlineServices ? Object.values(contact.onlineServices) : [];
  const personalInfo = contact.personalInfo ? Object.values(contact.personalInfo) : [];
  const notes = contact.notes ? Object.values(contact.notes) : [];
  const keywords = getContactKeywords(contact);
  const relatedTo = contact.relatedTo ? Object.entries(contact.relatedTo) : [];
  const bookIds = Object.keys(contact.addressBookIds || {}).filter((k) => contact.addressBookIds[k]);
  const bookNames = bookIds
    .map((id) => addressBooks.find((b) => b.id === id)?.name)
    .filter(Boolean) as string[];

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

  const doDelete = async () => {
    setConfirmDelete(false);
    try {
      await deleteContact(contact.id);
      navigation.goBack();
    } catch (err) {
      Alert.alert('Delete failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const doDuplicate = async () => {
    const targetBookId = bookIds[0] || addressBooks[0]?.id;
    if (!targetBookId) {
      Alert.alert('No address book', 'Cannot duplicate without an address book.');
      return;
    }
    // Strip server-managed identity fields and re-create as a new card.
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

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.headerBtn} hitSlop={8}>
          <ArrowLeft size={22} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{name}</Text>
        <View style={styles.headerActions}>
          {!isGroup(contact) && (
            <Pressable
              onPress={() => { void doDuplicate(); }}
              style={styles.headerBtn}
              hitSlop={8}
            >
              <Copy size={18} color={c.text} />
            </Pressable>
          )}
          <Pressable
            onPress={() => navigation.navigate('ContactForm', { contactId: contact.id })}
            style={styles.headerBtn}
            hitSlop={8}
          >
            <Edit2 size={18} color={c.text} />
          </Pressable>
          <Pressable
            onPress={() => setConfirmDelete(true)}
            style={styles.headerBtn}
            hitSlop={8}
          >
            <Trash2 size={18} color={c.error} />
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
          {!!title && <Text style={styles.heroSubtitle}>{title}</Text>}
          {!!org && <Text style={styles.heroSubtitle}>{org}</Text>}
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
          {!!name && (
            <QuickAction
              icon={<Share2 size={18} color={c.primary} />}
              label="Share"
              onPress={async () => {
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
              }}
            />
          )}
        </View>

        {emails.length > 0 && (
          <Section icon={<Mail size={14} color={c.primary} />} title="Email" category="contact">
            {emails.map((e) => (
              <Pressable key={e.id} onPress={() => openMail(e.address)} style={styles.fieldRow}>
                <Text style={styles.fieldValue} selectable>{e.address}</Text>
                {!!e.label && <Text style={styles.fieldLabel}>{e.label}</Text>}
                <ContextChips contexts={e.contexts} />
              </Pressable>
            ))}
          </Section>
        )}

        {phones.length > 0 && (
          <Section icon={<Phone size={14} color={c.primary} />} title="Phone" category="contact">
            {phones.map((p) => (
              <Pressable key={p.id} onPress={() => openTel(p.number)} style={styles.fieldRow}>
                <Text style={styles.fieldValue} selectable>{p.number}</Text>
                {!!p.label && <Text style={styles.fieldLabel}>{p.label}</Text>}
                <ContextChips contexts={p.contexts} />
              </Pressable>
            ))}
          </Section>
        )}

        {orgs.length > 0 && (
          <Section icon={<Building size={14} color={c.calendar.orange} />} title="Organization" category="work">
            {orgs.map((o, i) => (
              <View key={i} style={styles.fieldRow}>
                <Text style={styles.fieldValue}>{o.name}</Text>
                {!!(o.units && o.units.length) && (
                  <Text style={styles.fieldLabel}>{o.units.map((u) => u.name).join(', ')}</Text>
                )}
              </View>
            ))}
          </Section>
        )}

        {titles.length > 0 && (
          <Section icon={<Briefcase size={14} color={c.calendar.orange} />} title="Title" category="work">
            {titles.map((tl, i) => (
              <View key={i} style={styles.fieldRow}>
                <Text style={styles.fieldValue}>{tl.name}</Text>
                {!!tl.kind && <Text style={styles.fieldLabel}>{tl.kind}</Text>}
              </View>
            ))}
          </Section>
        )}

        {addresses.length > 0 && (
          <Section icon={<MapPin size={14} color={c.calendar.green} />} title="Addresses" category="location">
            {addresses.map((a) => {
              const formatted = formatAddress(a);
              return (
                <Pressable key={a.id} onPress={() => formatted && openMap(formatted)} style={styles.fieldRow}>
                  <Text style={styles.fieldValue}>{formatted}</Text>
                  <ContextChips contexts={a.contexts} />
                </Pressable>
              );
            })}
          </Section>
        )}

        {anniversaries.length > 0 && (
          <Section icon={<Cake size={14} color={c.calendar.pink} />} title="Anniversaries" category="personal">
            {anniversaries.map((a, i) => (
              <View key={i} style={styles.fieldRow}>
                <Text style={styles.fieldValue}>{formatPartialDate(a.date)}</Text>
                <Text style={styles.fieldLabel}>{a.kind}</Text>
              </View>
            ))}
          </Section>
        )}

        {onlineServices.length > 0 && (
          <Section icon={<Globe size={14} color={c.calendar.teal} />} title="Online" category="digital">
            {onlineServices.map((s, i) => (
              <Pressable
                key={i}
                onPress={() => s.uri && typeof s.uri === 'string' && s.uri.startsWith('http') && Linking.openURL(s.uri)}
                style={styles.fieldRow}
              >
                <Text style={styles.fieldValue}>{s.user || s.uri}</Text>
                {!!s.service && <Text style={styles.fieldLabel}>{s.service}</Text>}
                <ContextChips contexts={s.contexts} />
              </Pressable>
            ))}
          </Section>
        )}

        {personalInfo.length > 0 && (
          <Section icon={<Heart size={14} color={c.calendar.pink} />} title="Personal" category="personal">
            {personalInfo.map((pi, i) => (
              <View key={i} style={styles.fieldRow}>
                <Text style={styles.fieldValue}>{pi.value}</Text>
                <Text style={styles.fieldLabel}>{pi.kind}{pi.level ? ` (${pi.level})` : ''}</Text>
              </View>
            ))}
          </Section>
        )}

        {relatedTo.length > 0 && (
          <Section icon={<Users size={14} color={c.calendar.pink} />} title="Related" category="personal">
            {relatedTo.map(([uri, rel], i) => {
              const relType = rel.relation ? Object.keys(rel.relation).find((k) => rel.relation![k]) : undefined;
              return (
                <View key={i} style={styles.fieldRow}>
                  <Text style={styles.fieldValue} numberOfLines={1}>{uri}</Text>
                  {!!relType && <Text style={styles.fieldLabel}>{relType}</Text>}
                </View>
              );
            })}
          </Section>
        )}

        {notes.length > 0 && (
          <Section icon={<FileText size={14} color={c.calendar.purple} />} title="Notes" category="notes">
            {notes.map((n, i) => (
              <Text key={i} style={styles.noteText}>{n.note}</Text>
            ))}
          </Section>
        )}

        {keywords.length > 0 && (
          <Section icon={<Tag size={14} color={c.calendar.teal} />} title="Tags" category="digital">
            <View style={styles.chipRow}>
              {keywords.map((kw) => (
                <View key={kw} style={styles.tagChip}>
                  <Text style={styles.tagChipText}>{kw}</Text>
                </View>
              ))}
            </View>
          </Section>
        )}

        {bookNames.length > 0 && (
          <Section icon={<BookUser size={14} color={c.textSecondary} />} title="Address Book" category="contact">
            {bookNames.map((n, i) => (
              <Text key={i} style={styles.fieldValue}>{n}</Text>
            ))}
          </Section>
        )}

        {!isGroup(contact) && <ContactActivity contact={contact} />}
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
    </SafeAreaView>
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
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  heroPhoto: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: c.surface,
  },
  heroName: { ...typography.h2, color: c.text, textAlign: 'center', marginTop: spacing.sm },
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

  section: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    borderLeftWidth: 3,
    paddingLeft: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: c.card,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.sm },
  sectionTitle: { ...typography.bodySemibold, color: c.text },
  sectionBody: { gap: spacing.sm },

  fieldRow: { gap: 2 },
  fieldValue: { ...typography.body, color: c.text },
  fieldLabel: { ...typography.caption, color: c.textMuted },
  noteText: { ...typography.body, color: c.text },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: 2 },
  contextChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: c.surface,
    borderRadius: radius.xs,
  },
  contextChipText: { ...typography.small, color: c.textMuted },
  tagChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: c.primaryBg,
  },
  tagChipText: { ...typography.caption, color: c.primary },

  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  missingText: { ...typography.body, color: c.textMuted },
  });
}
