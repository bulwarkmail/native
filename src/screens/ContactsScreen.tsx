import React from 'react';
import { View, Text, StyleSheet, SectionList, Pressable } from 'react-native';
import { Users } from 'lucide-react-native';
import { colors } from '../theme/colors';

const MOCK_CONTACTS = [
  { id: '1', name: 'Alice Johnson', email: 'alice@example.com', phone: '+1 555-0101' },
  { id: '2', name: 'Bob Smith', email: 'bob@example.com', phone: '+1 555-0102' },
  { id: '3', name: 'Carol Davis', email: 'carol@example.com', phone: '+1 555-0103' },
  { id: '4', name: 'David Wilson', email: 'david@example.com', phone: '+1 555-0104' },
  { id: '5', name: 'Emma Brown', email: 'emma@example.com', phone: '+1 555-0105' },
  { id: '6', name: 'Frank Miller', email: 'frank@example.com', phone: '+1 555-0106' },
  { id: '7', name: 'Grace Lee', email: 'grace@example.com', phone: '+1 555-0107' },
  { id: '8', name: 'Henry Taylor', email: 'henry@example.com', phone: '+1 555-0108' },
];

function groupByLetter(contacts: typeof MOCK_CONTACTS) {
  const groups: Record<string, typeof MOCK_CONTACTS> = {};
  contacts.forEach((c) => {
    const letter = c.name.charAt(0).toUpperCase();
    if (!groups[letter]) groups[letter] = [];
    groups[letter].push(c);
  });
  return Object.keys(groups)
    .sort()
    .map((letter) => ({ title: letter, data: groups[letter] }));
}

function ContactRow({ item }: { item: typeof MOCK_CONTACTS[0] }) {
  return (
    <Pressable style={({ pressed }) => [styles.contactRow, pressed && styles.contactRowPressed]}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{item.name.charAt(0)}</Text>
      </View>
      <View style={styles.contactInfo}>
        <Text style={styles.contactName}>{item.name}</Text>
        <Text style={styles.contactEmail}>{item.email}</Text>
      </View>
    </Pressable>
  );
}

export default function ContactsScreen() {
  const sections = React.useMemo(() => groupByLetter(MOCK_CONTACTS), []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Users size={24} color={colors.primary} />
        <Text style={styles.headerTitle}>Contacts</Text>
        <Text style={styles.headerCount}>{MOCK_CONTACTS.length}</Text>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ContactRow item={item} />}
        renderSectionHeader={({ section: { title } }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{title}</Text>
          </View>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 8,
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: colors.text, flex: 1 },
  headerCount: { fontSize: 13, color: colors.textSecondary },
  listContent: { paddingBottom: 20 },
  sectionHeader: {
    backgroundColor: colors.surface,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  contactRowPressed: { backgroundColor: colors.surfaceHover },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: { fontSize: 16, fontWeight: '600', color: colors.textInverse },
  contactInfo: { flex: 1 },
  contactName: { fontSize: 15, fontWeight: '500', color: colors.text },
  contactEmail: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  separator: { height: 1, backgroundColor: colors.borderLight, marginLeft: 68 },
});
