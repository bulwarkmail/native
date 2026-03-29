import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ArrowLeft, Star, Archive, Trash2, MoreVertical, Reply, ReplyAll, Forward,
  Paperclip, Download, Shield, ChevronDown, ChevronUp, Tag
} from 'lucide-react-native';
  import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';
import { Button } from '../components';

interface ThreadMessage {
  id: string;
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  cc?: { name: string; email: string }[];
  date: Date;
  bodyText: string;
  attachments?: { name: string; size: string; type: string }[];
  isCollapsed?: boolean;
}

const MOCK_THREAD: ThreadMessage[] = [
  {
    id: 'm1',
    from: { name: 'Alice Johnson', email: 'alice@example.com' },
    to: [{ name: 'You', email: 'user@bulwark.mail' }],
    date: new Date(2026, 2, 28, 14, 0),
    bodyText: 'Hi team,\n\nI wanted to share the latest progress on our Q2 deliverables.\n\nThe frontend refactor is 80% complete and we\'re on track for the April deadline. The new component library is looking great and performance benchmarks are promising.\n\nKey highlights:\n• Email client performance improved by 40%\n• Calendar rendering optimized for large event sets\n• Mobile responsive layout overhaul complete\n\nPlease review the attached timeline and let me know if you have any concerns.',
    attachments: [
      { name: 'Q2-Timeline.pdf', size: '2.4 MB', type: 'pdf' },
      { name: 'Benchmarks.xlsx', size: '845 KB', type: 'xlsx' },
    ],
    isCollapsed: true,
  },
  {
    id: 'm2',
    from: { name: 'Bob Smith', email: 'bob@company.org' },
    to: [{ name: 'Alice Johnson', email: 'alice@example.com' }, { name: 'You', email: 'user@bulwark.mail' }],
    date: new Date(2026, 2, 29, 9, 15),
    bodyText: 'Great progress, Alice!\n\nThe benchmarks look impressive. I have a couple questions:\n\n1. Have we tested the calendar on mobile devices with 500+ events?\n2. What\'s the plan for S/MIME integration in the new architecture?\n\nI\'ll circle back after reviewing the full timeline.',
    isCollapsed: true,
  },
  {
    id: 'm3',
    from: { name: 'Alice Johnson', email: 'alice@example.com' },
    to: [
      { name: 'Bob Smith', email: 'bob@company.org' },
      { name: 'You', email: 'user@bulwark.mail' },
    ],
    cc: [{ name: 'Carol Davis', email: 'carol@billing.co' }],
    date: new Date(2026, 2, 29, 10, 30),
    bodyText: 'Hi Bob,\n\nGreat questions!\n\n1. Yes — we tested with up to 2,000 events on Pixel 7 and iPhone 14. Scrolling stays at 60fps after the virtualization rewrite. See the attached benchmark for details.\n\n2. S/MIME is Phase 2 (May timeline). We\'re reusing the existing cert management from the web client. The crypto layer is protocol-agnostic so it ports cleanly.\n\nI\'ve CC\'d Carol to keep finance in the loop on the timeline.\n\nBest,\nAlice',
    attachments: [
      { name: 'Mobile-Benchmarks.pdf', size: '1.1 MB', type: 'pdf' },
    ],
  },
];

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function getFileTypeColor(type: string): string {
  switch (type) {
    case 'pdf': return colors.error;
    case 'xlsx': return colors.calendar.green;
    case 'doc': return colors.primary;
    default: return colors.textMuted;
  }
}

function MessageCard({ message, isLast }: { message: ThreadMessage; isLast: boolean }) {
  const [collapsed, setCollapsed] = React.useState(message.isCollapsed ?? false);

  return (
    <View style={[styles.messageCard, isLast && styles.messageCardLast]}>
      {/* Message header */}
      <Pressable style={styles.messageHeader} onPress={() => setCollapsed(!collapsed)}>
        <View style={[styles.messageAvatar, { backgroundColor: isLast ? colors.primary : colors.surfaceActive }]}>
          <Text style={[styles.messageAvatarText, { color: isLast ? colors.textInverse : colors.textSecondary }]}>
            {message.from.name.charAt(0)}
          </Text>
        </View>
        <View style={styles.messageHeaderContent}>
          <View style={styles.messageHeaderRow}>
            <Text style={styles.messageFromName} numberOfLines={1}>{message.from.name}</Text>
            <Text style={styles.messageDate}>{formatDate(message.date)}</Text>
          </View>
          <Text style={styles.messageToLine} numberOfLines={1}>
            to {message.to.map(t => t.name === 'You' ? 'me' : t.name.split(' ')[0]).join(', ')}
            {message.cc ? `, cc: ${message.cc.map(c => c.name.split(' ')[0]).join(', ')}` : ''}
          </Text>
        </View>
        {collapsed ? (
          <ChevronDown size={18} color={colors.textMuted} />
        ) : (
          <ChevronUp size={18} color={colors.textMuted} />
        )}
      </Pressable>

      {/* Message body (collapsible) */}
      {!collapsed && (
        <View style={styles.messageBody}>
          <Text style={styles.messageBodyText}>{message.bodyText}</Text>

          {/* Attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <View style={styles.attachmentSection}>
              <View style={styles.attachmentHeader}>
                <Paperclip size={14} color={colors.textMuted} />
                <Text style={styles.attachmentHeaderText}>
                  {message.attachments.length} attachment{message.attachments.length > 1 ? 's' : ''}
                </Text>
              </View>
              {message.attachments.map((att, idx) => (
                <Pressable key={idx} style={styles.attachmentRow}>
                  <View style={[styles.attachmentIcon, { backgroundColor: getFileTypeColor(att.type) + '20' }]}>
                    <Text style={[styles.attachmentIconText, { color: getFileTypeColor(att.type) }]}>
                      {att.type.toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.attachmentInfo}>
                    <Text style={styles.attachmentName} numberOfLines={1}>{att.name}</Text>
                    <Text style={styles.attachmentSize}>{att.size}</Text>
                  </View>
                  <Download size={16} color={colors.textMuted} />
                </Pressable>
              ))}
            </View>
          )}

          {/* Quick reply actions (only on last message) */}
          {isLast && (
            <View style={styles.quickActions}>
              <Button variant="outline" size="sm" icon={<Reply size={14} color={colors.primary} />}>
                Reply
              </Button>
              <Button variant="outline" size="sm" icon={<ReplyAll size={14} color={colors.primary} />}>
                Reply All
              </Button>
              <Button variant="outline" size="sm" icon={<Forward size={14} color={colors.primary} />}>
                Forward
              </Button>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

interface EmailThreadScreenProps {
  subject?: string;
  onBack?: () => void;
}

export default function EmailThreadScreen({ subject, onBack }: EmailThreadScreenProps) {
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Toolbar */}
      <View style={styles.toolbar}>
        <Pressable onPress={onBack} style={styles.toolbarBtn}>
          <ArrowLeft size={20} color={colors.text} />
        </Pressable>
        <View style={styles.toolbarActions}>
          <Pressable style={styles.toolbarBtn}>
            <Archive size={20} color={colors.text} />
          </Pressable>
          <Pressable style={styles.toolbarBtn}>
            <Trash2 size={20} color={colors.text} />
          </Pressable>
          <Pressable style={styles.toolbarBtn}>
            <Star size={20} color={colors.starred} fill={colors.starred} />
          </Pressable>
          <Pressable style={styles.toolbarBtn}>
            <MoreVertical size={20} color={colors.text} />
          </Pressable>
        </View>
      </View>

      <ScrollView style={styles.scrollContent} contentContainerStyle={styles.scrollContainer}>
        {/* Subject */}
        <View style={styles.subjectArea}>
          <Text style={styles.subjectText}>
            {subject || 'Project update for Q2 — milestones and timeline'}
          </Text>
          <View style={styles.subjectMeta}>
            <View style={styles.labelBadge}>
              <Tag size={10} color={colors.tags.blue.dot} />
              <Text style={[styles.labelText, { color: colors.tags.blue.dot }]}>Work</Text>
            </View>
            <Text style={styles.messageCount}>{MOCK_THREAD.length} messages</Text>
          </View>
        </View>

        {/* Messages */}
        {MOCK_THREAD.map((msg, index) => (
          <MessageCard
            key={msg.id}
            message={msg}
            isLast={index === MOCK_THREAD.length - 1}
          />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  // Toolbar
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  toolbarBtn: {
    width: componentSizes.avatarSm, height: componentSizes.avatarSm,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.full,
  },
  toolbarActions: { flexDirection: 'row', gap: spacing.xs },

  scrollContent: { flex: 1 },
  scrollContainer: { paddingBottom: 40 },

  // Subject
  subjectArea: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.md,
  },
  subjectText: { ...typography.h2, color: colors.text, lineHeight: 28 },
  subjectMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.sm },
  labelBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.tags.blue.bg,
  },
  labelText: { ...typography.small },
  messageCount: { ...typography.caption, color: colors.textMuted },

  // Message card — matches webmail card component
  messageCard: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  messageCardLast: {
    borderColor: colors.primaryBorder,
  },
  messageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.sm,
  },
  messageAvatar: {
    width: 36, height: 36,
    borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  messageAvatarText: { fontSize: typography.body.fontSize, fontWeight: '600' },
  messageHeaderContent: { flex: 1 },
  messageHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  messageFromName: { ...typography.bodyMedium, color: colors.text, flex: 1 },
  messageDate: { ...typography.small, color: colors.textMuted },
  messageToLine: { ...typography.small, color: colors.textMuted },

  // Message body
  messageBody: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  messageBodyText: {
    ...typography.base,
    color: colors.text,
    lineHeight: 24,
  },

  // Attachments
  attachmentSection: {
    marginTop: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceHover,
    overflow: 'hidden',
  },
  attachmentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  attachmentHeaderText: { ...typography.small, color: colors.textMuted },
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  attachmentIcon: {
    width: 36, height: 36,
    borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  attachmentIconText: { fontSize: 10, fontWeight: '700' },
  attachmentInfo: { flex: 1 },
  attachmentName: { ...typography.caption, color: colors.text },
  attachmentSize: { ...typography.small, color: colors.textMuted },

  // Quick actions — using outline buttons from webmail
  quickActions: {
    flexDirection: 'row',
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
});
