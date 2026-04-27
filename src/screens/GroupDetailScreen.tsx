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

type Nav = NativeStackNavigationProp<RootStackParamList, 'GroupDetail'>;
type Route = RouteProp<RootStackParamList, 'GroupDetail'>;

export default function GroupDetailScreen() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { groupId } = route.params;

  const allContacts = useContactsStore((s) => s.contacts);
  const updateContact = useContactsStore((s) => s.updateContact);
  const deleteContact = useContactsStore((s) => s.deleteContact);
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
          <Pressable onPress={() => navigation.goBack()} style={styles.headerBtn} hitSlop={8}>
            <ArrowLeft size={22} color={c.text} />
          </Pressable>
          <Text style={styles.headerTitle}>Group</Text>
        </View>
        <View style={styles.missing}>
          <Text style={styles.missingText}>Group not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  const name = getContactDisplayName(group) || 'Group';

  const emailAll = () => {
    const recipients: EmailAddress[] = [];
    for (const m of members) {
      const email = getContactPrimaryEmail(m);
      if (!email) continue;
      recipients.push({ name: getContactDisplayName(m) || '', email });
    }
    if (recipients.length === 0) {
      Alert.alert('No emails', 'None of the members have an email address.');
      return;
    }
    navigation.navigate('Compose', { prefillTo: recipients });
  };

  const addMembers = async (ids: string[]) => {
    const existing = group.members ? { ...group.members } : {};
    for (const id of ids) {
      const contact = allContacts.find((c) => c.id === id);
      const key = contact?.uid || id;
      existing[key] = true;
    }
    try {
      await updateContact(group.id, { members: existing });
    } catch (err) {
      Alert.alert('Failed to add members', err instanceof Error ? err.message : 'Unknown error');
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
      Alert.alert('Failed to remove member', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    try {
      await deleteContact(group.id);
      navigation.goBack();
    } catch (err) {
      Alert.alert('Delete failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const excludedIds = React.useMemo(() => new Set(members.map((m) => m.id)), [members]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} style={styles.headerBtn} hitSlop={8}>
          <ArrowLeft size={22} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{name}</Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => navigation.navigate('ContactForm', { contactId: group.id, asGroup: true })}
            style={styles.headerBtn}
            hitSlop={8}
          >
            <Edit2 size={18} color={c.text} />
          </Pressable>
          <Pressable onPress={() => setConfirmDelete(true)} style={styles.headerBtn} hitSlop={8}>
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
          {members.length} member{members.length === 1 ? '' : 's'}
        </Text>
      </View>

      <View style={styles.actionsRow}>
        <Pressable onPress={emailAll} style={styles.actionBtn}>
          <Mail size={16} color={c.primary} />
          <Text style={styles.actionLabel}>Email all</Text>
        </Pressable>
        <Pressable onPress={() => setPickerOpen(true)} style={[styles.actionBtn, styles.actionBtnPrimary]}>
          <Plus size={16} color={c.primaryForeground} />
          <Text style={[styles.actionLabel, styles.actionLabelPrimary]}>Add member</Text>
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
            >
              <UserMinus size={16} color={c.error} />
            </Pressable>
          </View>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Users size={40} color={c.surfaceActive} />
            <Text style={styles.emptyTitle}>No members yet</Text>
            <Text style={styles.emptySubtitle}>Tap "Add member" to get started</Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: spacing.xxxl }}
      />

      <ContactPickerSheet
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(ids) => { void addMembers(ids); }}
        title="Add members"
        excludedIds={excludedIds}
        multi
      />

      <Dialog
        visible={confirmDelete}
        title="Delete group"
        message={`Delete "${name}"? Members will not be deleted.`}
        variant="destructive"
        confirmText="Delete"
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />

      <Dialog
        visible={!!removingMember}
        title="Remove member"
        message={`Remove "${removingMember ? getContactDisplayName(removingMember) : ''}" from this group?`}
        variant="destructive"
        confirmText="Remove"
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
