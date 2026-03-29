import React from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  X, Send, Paperclip, ChevronDown, Bold, Italic, List,
  Link2, Image, MoreHorizontal, Minus
} from 'lucide-react-native';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';
import { Button } from '../components';

interface Recipient {
  name: string;
  email: string;
}

interface ComposeScreenProps {
  onClose?: () => void;
  onSend?: () => void;
  replyTo?: { from: Recipient; subject: string; body?: string };
}

function RecipientChip({ recipient, onRemove }: { recipient: Recipient; onRemove: () => void }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText} numberOfLines={1}>
        {recipient.name || recipient.email}
      </Text>
      <Pressable onPress={onRemove} hitSlop={8}>
        <X size={12} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

export default function ComposeScreen({ onClose, onSend, replyTo }: ComposeScreenProps) {
  const [toRecipients, setToRecipients] = React.useState<Recipient[]>(
    replyTo ? [replyTo.from] : []
  );
  const [ccVisible, setCcVisible] = React.useState(false);
  const [ccRecipients, setCcRecipients] = React.useState<Recipient[]>([]);
  const [subject, setSubject] = React.useState(
    replyTo ? `Re: ${replyTo.subject}` : ''
  );
  const [body, setBody] = React.useState('');
  const [toInput, setToInput] = React.useState('');
  const [ccInput, setCcInput] = React.useState('');

  const canSend = toRecipients.length > 0 && subject.trim().length > 0;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={onClose} style={styles.headerBtn}>
          <X size={22} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>
          {replyTo ? 'Reply' : 'New Message'}
        </Text>
        <View style={styles.headerRight}>
          <Pressable style={styles.headerBtn}>
            <Paperclip size={20} color={colors.text} />
          </Pressable>
          <Button
            variant="default"
            size="sm"
            onPress={onSend}
            disabled={!canSend}
            icon={<Send size={14} color={canSend ? colors.primaryForeground : colors.textMuted} />}
            style={!canSend ? styles.sendButtonDisabled : undefined}
          >
            Send
          </Button>
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled">
          {/* From */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>From</Text>
            <View style={styles.fieldContent}>
              <Text style={styles.fromText}>user@bulwark.mail</Text>
              <ChevronDown size={14} color={colors.textMuted} />
            </View>
          </View>

          {/* To */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>To</Text>
            <View style={styles.recipientField}>
              {toRecipients.map((r, i) => (
                <RecipientChip
                  key={i}
                  recipient={r}
                  onRemove={() => setToRecipients(prev => prev.filter((_, idx) => idx !== i))}
                />
              ))}
              <TextInput
                style={styles.recipientInput}
                placeholder="Add recipient..."
                placeholderTextColor={colors.textMuted}
                value={toInput}
                onChangeText={setToInput}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>
            {!ccVisible && (
              <Pressable onPress={() => setCcVisible(true)} style={styles.ccToggle}>
                <Text style={styles.ccToggleText}>Cc</Text>
              </Pressable>
            )}
          </View>

          {/* Cc (expandable) */}
          {ccVisible && (
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>Cc</Text>
              <View style={styles.recipientField}>
                {ccRecipients.map((r, i) => (
                  <RecipientChip
                    key={i}
                    recipient={r}
                    onRemove={() => setCcRecipients(prev => prev.filter((_, idx) => idx !== i))}
                  />
                ))}
                <TextInput
                  style={styles.recipientInput}
                  placeholder="Add Cc..."
                  placeholderTextColor={colors.textMuted}
                  value={ccInput}
                  onChangeText={setCcInput}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>
            </View>
          )}

          {/* Subject */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Subject</Text>
            <TextInput
              style={styles.subjectInput}
              placeholder="Email subject"
              placeholderTextColor={colors.textMuted}
              value={subject}
              onChangeText={setSubject}
            />
          </View>

          {/* Body */}
          <TextInput
            style={styles.bodyInput}
            placeholder="Write your message..."
            placeholderTextColor={colors.textMuted}
            value={body}
            onChangeText={setBody}
            multiline
            textAlignVertical="top"
          />

          {/* Quote (if replying) */}
          {replyTo?.body && (
            <View style={styles.quoteBlock}>
              <View style={styles.quoteBorder} />
              <View style={styles.quoteContent}>
                <Text style={styles.quoteMeta}>
                  On {new Date().toLocaleDateString()}, {replyTo.from.name} wrote:
                </Text>
                <Text style={styles.quoteText} numberOfLines={6}>
                  {replyTo.body}
                </Text>
              </View>
            </View>
          )}
        </ScrollView>

        {/* Formatting toolbar */}
        <View style={styles.formatBar}>
          <View style={styles.formatActions}>
            <Pressable style={styles.formatBtn}>
              <Bold size={18} color={colors.textSecondary} />
            </Pressable>
            <Pressable style={styles.formatBtn}>
              <Italic size={18} color={colors.textSecondary} />
            </Pressable>
            <Pressable style={styles.formatBtn}>
              <List size={18} color={colors.textSecondary} />
            </Pressable>
            <Pressable style={styles.formatBtn}>
              <Link2 size={18} color={colors.textSecondary} />
            </Pressable>
            <Pressable style={styles.formatBtn}>
              <Image size={18} color={colors.textSecondary} />
            </Pressable>
            <Pressable style={styles.formatBtn}>
              <MoreHorizontal size={18} color={colors.textSecondary} />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  headerBtn: {
    width: componentSizes.avatarSm, height: componentSizes.avatarSm,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.full,
  },
  headerTitle: { ...typography.bodyMedium, color: colors.text, flex: 1, marginLeft: spacing.sm },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  sendButtonDisabled: { backgroundColor: colors.surfaceActive },

  // Fields
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    minHeight: 44,
  },
  fieldLabel: {
    ...typography.caption,
    color: colors.textMuted,
    width: 52,
    paddingTop: spacing.xs,
  },
  fieldContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  fromText: { ...typography.body, color: colors.text },
  recipientField: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
  },
  recipientInput: {
    flex: 1,
    ...typography.body,
    color: colors.text,
    minWidth: 100,
    paddingVertical: 4,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.primaryBg,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    maxWidth: 200,
  },
  chipText: { ...typography.caption, color: colors.primary },
  ccToggle: { paddingHorizontal: spacing.sm, paddingVertical: 4 },
  ccToggleText: { ...typography.captionMedium, color: colors.primary },
  subjectInput: { flex: 1, ...typography.bodyMedium, color: colors.text },


  // Body
  bodyInput: {
    ...typography.body,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    minHeight: 200,
    lineHeight: 22,
  },

  // Quote
  quoteBlock: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xl,
  },
  quoteBorder: {
    width: 2,
    backgroundColor: colors.border,
    borderRadius: 2,
    marginRight: spacing.md,
  },
  quoteContent: { flex: 1 },
  quoteMeta: { ...typography.small, color: colors.textMuted, marginBottom: spacing.xs },
  quoteText: { ...typography.caption, color: colors.textSecondary, lineHeight: 18 },

  // Format bar
  formatBar: {
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  formatActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  formatBtn: {
    width: componentSizes.avatarSm, height: componentSizes.avatarSm,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm,
  },
});
