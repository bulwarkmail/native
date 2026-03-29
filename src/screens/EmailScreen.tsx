import React from 'react';
import { View, Text, StyleSheet, FlatList, Pressable } from 'react-native';
import { Mail, Star } from 'lucide-react-native';
import { colors } from '../theme/colors';

const MOCK_EMAILS = [
  { id: '1', from: 'Alice Johnson', subject: 'Project update for Q2', preview: 'Hi, I wanted to share the latest progress on our Q2 deliverables...', date: '10:30 AM', unread: true, starred: true },
  { id: '2', from: 'Bob Smith', subject: 'Re: Meeting tomorrow', preview: 'Sounds good! I\'ll bring the presentation slides...', date: '9:15 AM', unread: true, starred: false },
  { id: '3', from: 'Carol Davis', subject: 'Invoice #1234', preview: 'Please find attached the invoice for March services...', date: 'Yesterday', unread: false, starred: false },
  { id: '4', from: 'David Wilson', subject: 'Welcome to the team!', preview: 'We\'re excited to have you on board. Here are some resources...', date: 'Yesterday', unread: false, starred: true },
  { id: '5', from: 'Emma Brown', subject: 'Vacation request', preview: 'I\'d like to request time off from April 15-22...', date: 'Mar 27', unread: false, starred: false },
  { id: '6', from: 'Frank Miller', subject: 'Security alert', preview: 'We detected a new sign-in to your account from...', date: 'Mar 26', unread: false, starred: false },
  { id: '7', from: 'Grace Lee', subject: 'Newsletter: March Highlights', preview: 'Here\'s what happened this month in our community...', date: 'Mar 25', unread: false, starred: false },
  { id: '8', from: 'Henry Taylor', subject: 'Re: Code review', preview: 'Great work on the refactor! I left a few comments...', date: 'Mar 24', unread: false, starred: false },
];

function EmailRow({ item }: { item: typeof MOCK_EMAILS[0] }) {
  return (
    <Pressable style={({ pressed }) => [styles.emailRow, pressed && styles.emailRowPressed]}>
      <View style={styles.emailLeft}>
        <View style={[styles.avatar, { backgroundColor: item.unread ? colors.primary : colors.surfaceHover }]}>
          <Text style={[styles.avatarText, { color: item.unread ? colors.textInverse : colors.textSecondary }]}>
            {item.from.charAt(0)}
          </Text>
        </View>
      </View>
      <View style={styles.emailContent}>
        <View style={styles.emailHeader}>
          <Text style={[styles.emailFrom, item.unread && styles.emailUnread]} numberOfLines={1}>
            {item.from}
          </Text>
          <Text style={styles.emailDate}>{item.date}</Text>
        </View>
        <Text style={[styles.emailSubject, item.unread && styles.emailUnread]} numberOfLines={1}>
          {item.subject}
        </Text>
        <Text style={styles.emailPreview} numberOfLines={1}>
          {item.preview}
        </Text>
      </View>
      {item.starred && (
        <Star size={16} color={colors.starred} fill={colors.starred} style={styles.starIcon} />
      )}
    </Pressable>
  );
}

export default function EmailScreen() {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Mail size={24} color={colors.primary} />
        <Text style={styles.headerTitle}>Inbox</Text>
        <Text style={styles.headerCount}>2 unread</Text>
      </View>
      <FlatList
        data={MOCK_EMAILS}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <EmailRow item={item} />}
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
  emailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  emailRowPressed: { backgroundColor: colors.surfaceHover },
  emailLeft: { marginRight: 12 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 16, fontWeight: '600' },
  emailContent: { flex: 1 },
  emailHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  emailFrom: { fontSize: 15, color: colors.text, flex: 1, marginRight: 8 },
  emailDate: { fontSize: 12, color: colors.textMuted },
  emailSubject: { fontSize: 14, color: colors.text, marginBottom: 2 },
  emailPreview: { fontSize: 13, color: colors.textSecondary },
  emailUnread: { fontWeight: '700' },
  separator: { height: 1, backgroundColor: colors.borderLight, marginLeft: 68 },
  starIcon: { marginLeft: 8 },
});
