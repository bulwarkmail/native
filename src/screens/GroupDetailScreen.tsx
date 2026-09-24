import React from 'react';
import {
  View, Text, StyleSheet, Pressable, FlatList, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ArrowLeft, Edit2, Trash2, Plus, Users, Mail, UserMinus,
} from 'lucide-react-native';
import type { RootStackParamList } from '../navigation/types';
import type { ContactCard } from '../api/types';
import {
  useContactsStore,
  selectGroupMembers,
} from '../stores/contacts-store';
import {
  getContactDisplayName,
  getContactPrimaryEmail,
} from '../lib/contact-utils';
import type { EmailAddress } from '../api/types';
import ContactListRow from '../components/contacts/ContactListRow';
import ContactPickerSheet from '../components/contacts/ContactPickerSheet';
import Dialog from '../components/Dialog';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useLocaleStore } from '../stores/locale-store';

type Nav = NativeStackNavigationProp<RootStackParamList, 'GroupDetail'>;
type Route = RouteProp<RootStackParamList, 'GroupDetail'>;

export default function GroupDetailScreen() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const t = useLocaleStore((s) => s.t);
  const { groupId } = route.params;

  const allContacts = useContactsStore((s) => s.contacts);
  const updateContact = useContactsStore((s) => s.updateContact);
  const deleteContact = useContactsStore((s) => s.deleteContact);
  const addContactsToGroup = useContactsStore((s) => s.addContactsToGroup);
  const getGroupRecipients = useContactsStore((s) => s.getGroupRecipients);
  const group = React.useMemo(
    () => allContacts.find((c) => c.id === groupId),
    [allContacts, groupId],
  );
  const members = React.useMemo(
    () => selectGroupMembers({ contacts: allContacts } as Parameters<typeof selectGroupMembers>[0], groupId),
    [allContacts, groupId],
  );

  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [removingMember, setRemovingMember] = React.useState<ContactCard | null>(null);

  if (!group) {
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
          <Text style={styles.headerTitle}>{t('contacts.group', 'Group')}</Text>
        </View>
        <View style={styles.missing}>
          <Text style={styles.missingText}>{t('contacts.groups.not_found', 'Group not found')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const name = getContactDisplayName(group) || t('contacts.group', 'Group');

  const emailAll = () => {
    // One recipient per address: two members sharing a mailbox are sent once.
    const recipients: EmailAddress[] = getGroupRecipients(group.id);
    if (recipients.length === 0) {
      Alert.alert(
        t('contacts.groups.no_emails', 'No emails'),
        t('contacts.groups.no_member_emails', 'This group has no members with an email address.'),
      );
      return;
    }
    navigation.navigate('Compose', { prefillTo: recipients });
  };

  const addMembers = async (ids: string[]) => {
    try {
      await addContactsToGroup(group.id, ids);
    } catch (err) {
      Alert.alert(t('contacts.groups.add_members_failed', 'Failed to add members'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
    }
  };

  const removeMember = async (member: ContactCard) => {
    const existing = group.members ? { ...group.members } : {};
    // Remove by direct id and by uid
    for (const key of Object.keys(existing)) {
      const bare = key.startsWith('urn:uuid:') ? key.slice(9) : key;
      const bareUid = member.uid?.startsWith('urn:uuid:') ? member.uid.slice(9) : member.uid;
      if (key === member.id || bare === member.id || key === member.uid || bare === bareUid) {
        delete existing[key];
      }
    }
    try {
      await updateContact(group.id, { members: existing });
    } catch (err) {
      Alert.alert(t('contacts.groups.remove_member_failed', 'Failed to remove member'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
    }
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    try {
      await deleteContact(group.id);
      navigation.goBack();
    } catch (err) {
      Alert.alert(t('contacts.groups.delete_failed', 'Failed to delete group'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
    }
  };

  const excludedIds = React.useMemo(() => new Set(members.map((m) => m.id)), [members]);

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
        <Text style={styles.headerTitle} numberOfLines={1}>{name}</Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => navigation.navigate('ContactForm', { contactId: group.id, asGroup: true })}
            style={styles.headerBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('contacts.groups.edit', 'Edit Group')}
          >
            <Edit2 size={18} color={c.text} />
          </Pressable>
          <Pressable
            onPress={() => setConfirmDelete(true)}
            style={styles.headerBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('contacts.groups.delete_confirm_title', 'Delete group')}
          >
            <Trash2 size={18} color={c.error} />
          </Pressable>
        </View>
      </View>

      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Users size={32} color={c.primary} />
        </View>
        <Text style={styles.heroName}>{name}</Text>
        <Text style={styles.heroSubtitle}>
          {t('contacts.groups.member_count', '{count, plural, =0 {No members} one {1 member} other {# members}}', { count: members.length })}
        </Text>
      </View>

      <View style={styles.actionsRow}>
        <Pressable onPress={emailAll} style={styles.actionBtn} accessibilityRole="button">
          <Mail size={16} color={c.primary} />
          <Text style={styles.actionLabel}>{t('contacts.groups.email_all', 'Email all')}</Text>
        </Pressable>
        <Pressable
          onPress={() => setPickerOpen(true)}
          style={[styles.actionBtn, styles.actionBtnPrimary]}
          accessibilityRole="button"
        >
          <Plus size={16} color={c.primaryForeground} />
          <Text style={[styles.actionLabel, styles.actionLabelPrimary]}>{t('contacts.groups.add_member', 'Add member')}</Text>
        </Pressable>
      </View>

      <FlatList
        data={members}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => (
          <View style={styles.memberRow}>
            <View style={{ flex: 1 }}>
              <ContactListRow
                contact={item}
                onPress={() => navigation.navigate('ContactDetail', { contactId: item.id })}
              />
            </View>
            <Pressable
              onPress={() => setRemovingMember(item)}
              style={styles.removeMemberBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('contacts.groups.remove_member', 'Remove member')}
            >
              <UserMinus size={16} color={c.error} />
            </Pressable>
          </View>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Users size={40} color={c.surfaceActive} />
            <Text style={styles.emptyTitle}>{t('contacts.groups.no_members', 'No members in this group')}</Text>
            <Text style={styles.emptySubtitle}>{t('contacts.groups.no_members_hint', 'Tap "Add member" to get started')}</Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: spacing.xxxl }}
      />

      <ContactPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(ids) => { void addMembers(ids); }}
        title={t('contacts.groups.add_members', 'Add members')}
        excludedIds={excludedIds}
        multi
      />

      <Dialog
        visible={confirmDelete}
        title={t('contacts.groups.delete_confirm_title', 'Delete group')}
        message={t('contacts.groups.delete_confirm_named', 'Delete "{name}"? Members will not be deleted.', { name })}
        variant="destructive"
        confirmText={t('contacts.context_menu.delete', 'Delete')}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />

      <Dialog
        visible={!!removingMember}
        title={t('contacts.groups.remove_member', 'Remove member')}
        message={t('contacts.groups.remove_member_confirm', 'Remove "{name}" from this group?', {
          name: removingMember ? getContactDisplayName(removingMember) : '',
        })}
        variant="destructive"
        confirmText={t('common.remove', 'Remove')}
        onConfirm={() => {
          if (removingMember) void removeMember(removingMember);
          setRemovingMember(null);
        }}
        onCancel={() => setRemovingMember(null)}
      />
    </SafeAreaView>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
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
    gap: spacing.xs,
  },
  heroIcon: {
    width: 80, height: 80,
    borderRadius: 40,
    backgroundColor: c.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroName: { ...typography.h2, color: c.text, marginTop: spacing.sm },
  heroSubtitle: { ...typography.body, color: c.textSecondary },

  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: c.surface,
  },
  actionBtnPrimary: { backgroundColor: c.primary },
  actionLabel: { ...typography.bodyMedium, color: c.text },
  actionLabelPrimary: { color: c.primaryForeground },

  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  removeMemberBtn: {
    width: 40, height: 40,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.full,
    marginRight: spacing.md,
  },
  separator: { height: 1, backgroundColor: c.borderLight, marginLeft: 68 },

  empty: { alignItems: 'center', paddingVertical: spacing.xxxl, gap: spacing.sm },
  emptyTitle: { ...typography.bodyMedium, color: c.textSecondary },
  emptySubtitle: { ...typography.caption, color: c.textMuted },

  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  missingText: { ...typography.body, color: c.textMuted },
  });
}
