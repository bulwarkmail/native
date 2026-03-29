import React from 'react';
import { View, Text, StyleSheet, SectionList, Pressable, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Search, Plus, Phone, Mail, ChevronRight, UserCircle, X
} from 'lucide-react-native';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';
import { Button } from '../components';

interface Contact {
  id: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  avatar?: string;
}

const MOCK_CONTACTS: Contact[] = [
  { id: '1', name: 'Alice Johnson', email: 'alice@example.com', phone: '+1 555-0101', company: 'Acme Inc' },
  { id: '2', name: 'Bob Smith', email: 'bob@company.org', phone: '+1 555-0102', company: 'TechCorp' },
  { id: '3', name: 'Carol Davis', email: 'carol@billing.co', company: 'Billing Co' },
  { id: '4', name: 'David Wilson', email: 'david@startup.io', phone: '+1 555-0104' },
  { id: '5', name: 'Emma Brown', email: 'emma@hr.org', phone: '+1 555-0105', company: 'HR Solutions' },
  { id: '6', name: 'Frank Miller', email: 'frank@dev.team', company: 'DevTeam' },
  { id: '7', name: 'Grace Lee', email: 'grace@newsletter.com', phone: '+1 555-0107' },
  { id: '8', name: 'Henry Taylor', email: 'henry@dev.team', phone: '+1 555-0108', company: 'DevTeam' },
  { id: '9', name: 'Iris Chen', email: 'iris@design.co', company: 'Design Studio' },
  { id: '10', name: 'Jack Brown', email: 'jack@sales.io', phone: '+1 555-0110' },
  { id: '11', name: 'Karen White', email: 'karen@ops.co', phone: '+1 555-0111', company: 'OpsCo' },
  { id: '12', name: 'Leo Garcia', email: 'leo@eng.dev', company: 'Engineering' },
];

function groupContacts(contacts: Contact[]) {
  const groups: Record<string, Contact[]> = {};
  contacts.forEach(c => {
    const letter = c.name.charAt(0).toUpperCase();
    if (!groups[letter]) groups[letter] = [];
    groups[letter].push(c);
  });
  return Object.keys(groups).sort().map(letter => ({
    title: letter,
    data: groups[letter].sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

function ContactRow({ contact, onPress }: { contact: Contact; onPress: () => void }) {
  const initials = contact.name.split(' ').map(n => n[0]).join('').slice(0, 2);

  return (
    <Pressable
      style={({ pressed }) => [styles.contactRow, pressed && styles.contactRowPressed]}
      onPress={onPress}
    >
      <View style={styles.contactAvatar}>
        <Text style={styles.contactAvatarText}>{initials}</Text>
      </View>
      <View style={styles.contactInfo}>
        <Text style={styles.contactName}>{contact.name}</Text>
        <Text style={styles.contactEmail} numberOfLines={1}>{contact.email}</Text>
        {contact.company && (
          <Text style={styles.contactCompany}>{contact.company}</Text>
        )}
      </View>
      <View style={styles.contactActions}>
        {contact.phone && (
          <Pressable style={styles.contactActionBtn} hitSlop={8}>
            <Phone size={16} color={colors.primary} />
          </Pressable>
        )}
        <Pressable style={styles.contactActionBtn} hitSlop={8}>
          <Mail size={16} color={colors.primary} />
        </Pressable>
      </View>
    </Pressable>
  );
}

interface ContactsScreenProps {
  onContactPress?: (contact: Contact) => void;
  onCreateContact?: () => void;
}

export default function ContactsScreen({ onContactPress, onCreateContact }: ContactsScreenProps) {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchActive, setSearchActive] = React.useState(false);

  const filtered = searchQuery
    ? MOCK_CONTACTS.filter(c =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.company && c.company.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : MOCK_CONTACTS;

  const sections = groupContacts(filtered);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Contacts</Text>
        <Text style={styles.headerCount}>{MOCK_CONTACTS.length}</Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => setSearchActive(!searchActive)}
            style={styles.headerBtn}
          >
            <Search size={20} color={colors.text} />
          </Pressable>
          <Button variant="default" size="icon" onPress={onCreateContact} style={styles.addButton}>
            <Plus size={18} color={colors.primaryForeground} />
          </Button>
        </View>
      </View>

      {/* Search */}
      {searchActive && (
        <View style={styles.searchBar}>
          <Search size={16} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search contacts..."
            placeholderTextColor={colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery('')}>
              <X size={16} color={colors.textMuted} />
            </Pressable>
          )}
        </View>
      )}

      {/* Contact list */}
      <SectionList
        sections={sections}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <ContactRow contact={item} onPress={() => onContactPress?.(item)} />
        )}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionHeaderText}>{section.title}</Text>
          </View>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        stickySectionHeadersEnabled
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <UserCircle size={48} color={colors.surfaceActive} />
            <Text style={styles.emptyTitle}>No contacts found</Text>
            <Text style={styles.emptySubtitle}>Try a different search</Text>
          </View>
        }
      />

      {/* Alphabet index */}
      <View style={styles.alphabetIndex}>
        {sections.map(s => (
          <Text key={s.title} style={styles.alphabetLetter}>{s.title}</Text>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  listContent: { paddingBottom: 80 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  headerTitle: { ...typography.h3, color: colors.text },
  headerCount: {
    ...typography.small,
    color: colors.textMuted,
    backgroundColor: colors.surface,
    borderRadius: radius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  headerActions: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm },
  headerBtn: {
    width: 40, height: 40,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.full,
  },
  addButton: {
    borderRadius: radius.full,
  },

  // Search — matches webmail input styling
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    height: componentSizes.inputHeight,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  searchInput: { flex: 1, ...typography.body, color: colors.text },

  // Section header
  sectionHeader: {
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  sectionHeaderText: { ...typography.small, color: colors.primary },

  // Contact row
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  contactRowPressed: { backgroundColor: colors.surfaceHover },
  contactAvatar: {
    width: componentSizes.avatarMd, height: componentSizes.avatarMd,
    borderRadius: componentSizes.avatarMd / 2,
    backgroundColor: colors.primaryBg,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.md,
  },
  contactAvatarText: { ...typography.bodyMedium, color: colors.primary },
  contactInfo: { flex: 1 },
  contactName: { ...typography.bodyMedium, color: colors.text },
  contactEmail: { ...typography.caption, color: colors.textMuted, marginTop: 1 },
  contactCompany: { ...typography.small, color: colors.textSecondary, marginTop: 1 },
  contactActions: { flexDirection: 'row', gap: spacing.sm },
  contactActionBtn: {
    width: 32, height: 32,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: colors.primaryBg,
  },
  separator: { height: 1, backgroundColor: colors.borderLight, marginLeft: 68 },

  // Alphabet index
  alphabetIndex: {
    position: 'absolute',
    right: 2,
    top: '20%',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  alphabetLetter: {
    ...typography.small,
    color: colors.primary,
    paddingVertical: 1,
    paddingHorizontal: 4,
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xxxl * 2,
    gap: spacing.sm,
  },
  emptyTitle: { ...typography.bodyMedium, color: colors.textSecondary },
  emptySubtitle: { ...typography.caption, color: colors.textMuted },
});
