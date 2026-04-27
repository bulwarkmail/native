import React from 'react';
import {
  View, Text, StyleSheet, TextInput, Pressable, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  X, Send, Paperclip, ChevronDown, Bold, Italic, List,
  Link2, Image as ImageIcon, MoreHorizontal,
} from 'lucide-react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { Button } from '../components';
import { useEmailStore } from '../stores/email-store';
import { useContactsStore } from '../stores/contacts-store';
import { isGroup } from '../lib/contact-utils';
import {
  getContactDisplayName,
  getContactInitials,
  matchesContactSearch,
} from '../lib/contact-utils';
import { getIdentities } from '../api/identity';
import { sendEmail } from '../api/email';
import type { EmailAddress, Identity, ContactCard } from '../api/types';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Compose'>;

interface Recipient {
  name: string;
  email: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseRecipients(input: string): Recipient[] {
  return input
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((email) => ({ name: '', email }));
}

function RecipientChip({ recipient, onRemove }: { recipient: Recipient; onRemove: () => void }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText} numberOfLines={1}>
        {recipient.name || recipient.email}
      </Text>
      <Pressable onPress={onRemove} hitSlop={8}>
        <X size={12} color={c.textMuted} />
      </Pressable>
    </View>
  );
}

function SuggestionList({
  suggestions, onPick,
}: {
  suggestions: Array<{ contact: ContactCard; name: string; email: string }>;
  onPick: (s: { name: string; email: string }) => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.suggestionBox}>
      {suggestions.map((s, i) => {
        const initials = getContactInitials(s.contact);
        return (
          <Pressable
            key={`${s.contact.id}-${s.email}-${i}`}
            onPress={() => onPick(s)}
            style={({ pressed }) => [styles.suggestionRow, pressed && styles.suggestionRowPressed]}
          >
            <View style={styles.suggestionAvatar}>
              <Text style={styles.suggestionAvatarText}>{initials}</Text>
            </View>
            <View style={styles.suggestionText}>
              <Text style={styles.suggestionName} numberOfLines={1}>
                {s.name || s.email}
              </Text>
              {!!s.name && (
                <Text style={styles.suggestionEmail} numberOfLines={1}>{s.email}</Text>
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function ComposeScreen({ route, navigation }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const replyTo = route.params?.replyTo;
  const mode = route.params?.mode;
  const prefillTo = route.params?.prefillTo;
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const sentMailbox = React.useMemo(
    () => mailboxes.find((m) => m.role === 'sent'),
    [mailboxes],
  );

  const [identities, setIdentities] = React.useState<Identity[]>([]);
  const [identityError, setIdentityError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);

  const initialTo = React.useMemo<Recipient[]>(() => {
    if (!replyTo) {
      if (prefillTo && prefillTo.length > 0) {
        return prefillTo
          .filter((r) => !!r.email)
          .map((r) => ({ name: r.name ?? '', email: r.email }));
      }
      return [];
    }
    if (mode === 'forward') return [];
    // reply + replyAll both include the original sender
    const base: Recipient[] = replyTo.from.email
      ? [{ name: replyTo.from.name ?? '', email: replyTo.from.email }]
      : [];
    if (mode === 'replyAll' && replyTo.to) {
      for (const r of replyTo.to) {
        if (r.email && !base.some((b) => b.email === r.email)) {
          base.push({ name: r.name ?? '', email: r.email });
        }
      }
    }
    return base;
  }, [replyTo, mode, prefillTo]);

  const initialCc = React.useMemo<Recipient[]>(() => {
    if (mode !== 'replyAll' || !replyTo?.cc) return [];
    return replyTo.cc
      .filter((r) => !!r.email)
      .map((r) => ({ name: r.name ?? '', email: r.email }));
  }, [replyTo, mode]);

  const initialSubject = React.useMemo(() => {
    if (!replyTo) return '';
    const s = replyTo.subject ?? '';
    if (mode === 'forward') {
      return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`;
    }
    return /^re:/i.test(s) ? s : `Re: ${s}`;
  }, [replyTo, mode]);

  const [toRecipients, setToRecipients] = React.useState<Recipient[]>(initialTo);
  const [ccRecipients, setCcRecipients] = React.useState<Recipient[]>(initialCc);
  const [ccVisible, setCcVisible] = React.useState(initialCc.length > 0);
  const [toInput, setToInput] = React.useState('');
  const [ccInput, setCcInput] = React.useState('');
  const [subject, setSubject] = React.useState(initialSubject);
  const [body, setBody] = React.useState('');
  const [activeField, setActiveField] = React.useState<'to' | 'cc' | null>(null);

  const allContacts = useContactsStore((s) => s.contacts);
  const individuals = React.useMemo(() => allContacts.filter((c) => !isGroup(c)), [allContacts]);

  const suggestionQuery = activeField === 'to' ? toInput : activeField === 'cc' ? ccInput : '';
  const alreadySelected = React.useMemo(
    () => new Set([...toRecipients, ...ccRecipients].map((r) => r.email.toLowerCase())),
    [toRecipients, ccRecipients],
  );
  const suggestions: Array<{ contact: ContactCard; name: string; email: string }> = React.useMemo(() => {
    const q = suggestionQuery.trim();
    if (q.length < 1) return [];
    const out: Array<{ contact: ContactCard; name: string; email: string }> = [];
    for (const c of individuals) {
      if (!matchesContactSearch(c, q)) continue;
      if (!c.emails) continue;
      const name = getContactDisplayName(c);
      for (const e of Object.values(c.emails)) {
        if (!e.address) continue;
        if (alreadySelected.has(e.address.toLowerCase())) continue;
        out.push({ contact: c, name, email: e.address });
        if (out.length >= 8) break;
      }
      if (out.length >= 8) break;
    }
    return out;
  }, [suggestionQuery, individuals, alreadySelected]);

  const pickSuggestion = (s: { name: string; email: string }) => {
    const recipient: Recipient = { name: s.name, email: s.email };
    if (activeField === 'cc') {
      setCcRecipients((prev) => [...prev, recipient]);
      setCcInput('');
    } else {
      setToRecipients((prev) => [...prev, recipient]);
      setToInput('');
    }
  };

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await getIdentities();
        if (!cancelled) setIdentities(list);
      } catch (e) {
        if (!cancelled) {
          setIdentityError(e instanceof Error ? e.message : 'Failed to load identities');
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const primaryIdentity = identities[0];

  const commitTyped = () => {
    const extraTo = parseRecipients(toInput);
    const extraCc = parseRecipients(ccInput);
    const finalTo = [...toRecipients, ...extraTo];
    const finalCc = [...ccRecipients, ...extraCc];
    return { finalTo, finalCc };
  };

  const addTyped = () => {
    const extraTo = parseRecipients(toInput);
    const extraCc = parseRecipients(ccInput);
    if (extraTo.length) {
      setToRecipients((prev) => [...prev, ...extraTo]);
      setToInput('');
    }
    if (extraCc.length) {
      setCcRecipients((prev) => [...prev, ...extraCc]);
      setCcInput('');
    }
  };

  const { finalTo, finalCc } = commitTyped();
  const hasValidRecipients = finalTo.every((r) => EMAIL_RE.test(r.email)) && finalTo.length > 0;
  const canSend =
    !sending &&
    hasValidRecipients &&
    subject.trim().length > 0 &&
    !!primaryIdentity &&
    !!sentMailbox;

  const onClose = () => navigation.goBack();

  const onSend = async () => {
    if (!canSend || !primaryIdentity || !sentMailbox) return;
    setSending(true);
    try {
      const from: EmailAddress[] = [{ name: primaryIdentity.name, email: primaryIdentity.email }];
      const bodyWithQuote = replyTo?.body
        ? `${body}\n\n---\nOn ${new Date().toLocaleDateString()}, ${replyTo.from.name || replyTo.from.email} wrote:\n${replyTo.body.split('\n').map((l) => `> ${l}`).join('\n')}`
        : body;

      await sendEmail(
        {
          from,
          to: finalTo.map((r) => ({ name: r.name || undefined, email: r.email })),
          cc: finalCc.length
            ? finalCc.map((r) => ({ name: r.name || undefined, email: r.email }))
            : undefined,
          subject,
          textBody: bodyWithQuote,
          inReplyTo: replyTo?.inReplyTo,
          references: replyTo?.references,
        },
        primaryIdentity.id,
        sentMailbox.id,
      );
      navigation.goBack();
    } catch (e) {
      Alert.alert('Send failed', e instanceof Error ? e.message : 'Failed to send email');
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable onPress={onClose} style={styles.headerBtn}>
          <X size={22} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle}>
          {mode === 'forward' ? 'Forward' : mode === 'replyAll' ? 'Reply All' : replyTo ? 'Reply' : 'New Message'}
        </Text>
        <View style={styles.headerRight}>
          <Pressable style={styles.headerBtn}>
            <Paperclip size={20} color={c.text} />
          </Pressable>
          <Button
            variant="default"
            size="sm"
            onPress={() => { void onSend(); }}
            disabled={!canSend}
            icon={
              sending ? (
                <ActivityIndicator color={c.primaryForeground} size="small" />
              ) : (
                <Send
                  size={14}
                  color={canSend ? c.primaryForeground : c.textMuted}
                />
              )
            }
            style={!canSend ? styles.sendButtonDisabled : undefined}
          >
            {sending ? 'Sending...' : 'Send'}
          </Button>
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled">
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>From</Text>
            <View style={styles.fieldContent}>
              <Text style={styles.fromText} numberOfLines={1}>
                {primaryIdentity?.email ?? (identityError ? 'identity unavailable' : 'Loading...')}
              </Text>
              <ChevronDown size={14} color={c.textMuted} />
            </View>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>To</Text>
            <View style={styles.recipientField}>
              {toRecipients.map((r, i) => (
                <RecipientChip
                  key={i}
                  recipient={r}
                  onRemove={() => setToRecipients((prev) => prev.filter((_, idx) => idx !== i))}
                />
              ))}
              <TextInput
                style={styles.recipientInput}
                placeholder="Add recipient..."
                placeholderTextColor={c.textMuted}
                value={toInput}
                onChangeText={setToInput}
                onFocus={() => setActiveField('to')}
                onBlur={() => {
                  addTyped();
                  setTimeout(() => setActiveField((f) => (f === 'to' ? null : f)), 200);
                }}
                onSubmitEditing={addTyped}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            {activeField === 'to' && suggestions.length > 0 && (
              <SuggestionList suggestions={suggestions} onPick={pickSuggestion} />
            )}
            {!ccVisible && (
              <Pressable onPress={() => setCcVisible(true)} style={styles.ccToggle}>
                <Text style={styles.ccToggleText}>Cc</Text>
              </Pressable>
            )}
          </View>

          {ccVisible && (
            <View style={styles.fieldRow}>
              <Text style={styles.fieldLabel}>Cc</Text>
              <View style={styles.recipientField}>
                {ccRecipients.map((r, i) => (
                  <RecipientChip
                    key={i}
                    recipient={r}
                    onRemove={() => setCcRecipients((prev) => prev.filter((_, idx) => idx !== i))}
                  />
                ))}
                <TextInput
                  style={styles.recipientInput}
                  placeholder="Add Cc..."
                  placeholderTextColor={c.textMuted}
                  value={ccInput}
                  onChangeText={setCcInput}
                  onFocus={() => setActiveField('cc')}
                  onBlur={() => {
                    addTyped();
                    setTimeout(() => setActiveField((f) => (f === 'cc' ? null : f)), 200);
                  }}
                  onSubmitEditing={addTyped}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              {activeField === 'cc' && suggestions.length > 0 && (
                <SuggestionList suggestions={suggestions} onPick={pickSuggestion} />
              )}
            </View>
          )}

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Subject</Text>
            <TextInput
              style={styles.subjectInput}
              placeholder="Email subject"
              placeholderTextColor={c.textMuted}
              value={subject}
              onChangeText={setSubject}
            />
          </View>

          <TextInput
            style={styles.bodyInput}
            placeholder="Write your message..."
            placeholderTextColor={c.textMuted}
            value={body}
            onChangeText={setBody}
            multiline
            textAlignVertical="top"
          />

          {replyTo?.body && (
            <View style={styles.quoteBlock}>
              <View style={styles.quoteBorder} />
              <View style={styles.quoteContent}>
                <Text style={styles.quoteMeta}>
                  On {new Date().toLocaleDateString()}, {replyTo.from.name || replyTo.from.email} wrote:
                </Text>
                <Text style={styles.quoteText} numberOfLines={6}>
                  {replyTo.body}
                </Text>
              </View>
            </View>
          )}
        </ScrollView>

        <View style={styles.formatBar}>
          <View style={styles.formatActions}>
            <Pressable style={styles.formatBtn}>
              <Bold size={18} color={c.textSecondary} />
            </Pressable>
            <Pressable style={styles.formatBtn}>
              <Italic size={18} color={c.textSecondary} />
            </Pressable>
            <Pressable style={styles.formatBtn}>
              <List size={18} color={c.textSecondary} />
            </Pressable>
            <Pressable style={styles.formatBtn}>
              <Link2 size={18} color={c.textSecondary} />
            </Pressable>
            <Pressable style={styles.formatBtn}>
              <ImageIcon size={18} color={c.textSecondary} />
            </Pressable>
            <Pressable style={styles.formatBtn}>
              <MoreHorizontal size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  flex: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    gap: spacing.sm,
  },
  headerBtn: {
    width: componentSizes.buttonLg,
    height: componentSizes.buttonLg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  headerTitle: { ...typography.h3, color: c.text, flex: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sendButtonDisabled: { opacity: 0.5 },

  fieldRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
    gap: spacing.md,
  },
  fieldLabel: {
    ...typography.body,
    color: c.textMuted,
    width: 56,
    paddingTop: 10,
  },
  fieldContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: spacing.sm,
  },
  fromText: { ...typography.body, color: c.text },
  recipientField: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 4,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: c.surfaceActive,
    maxWidth: 220,
  },
  chipText: { ...typography.caption, color: c.text, flexShrink: 1 },
  recipientInput: {
    flexGrow: 1,
    minWidth: 100,
    ...typography.body,
    color: c.text,
    paddingVertical: 6,
  },
  suggestionBox: {
    marginTop: spacing.xs,
    marginLeft: 60,
    borderWidth: 1,
    borderColor: c.borderLight,
    borderRadius: radius.sm,
    backgroundColor: c.card,
    overflow: 'hidden',
  },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  suggestionRowPressed: { backgroundColor: c.surfaceHover },
  suggestionAvatar: {
    width: 32, height: 32,
    borderRadius: 16,
    backgroundColor: c.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestionAvatarText: { ...typography.captionMedium, color: c.primary },
  suggestionText: { flex: 1 },
  suggestionName: { ...typography.bodyMedium, color: c.text },
  suggestionEmail: { ...typography.caption, color: c.textSecondary },
  ccToggle: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  ccToggleText: { ...typography.caption, color: c.primary },
  subjectInput: {
    flex: 1,
    ...typography.body,
    color: c.text,
    paddingVertical: 10,
  },

  bodyInput: {
    ...typography.body,
    color: c.text,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 200,
    lineHeight: 22,
  },

  quoteBlock: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  quoteBorder: { width: 3, backgroundColor: c.border, borderRadius: radius.xs },
  quoteContent: { flex: 1 },
  quoteMeta: { ...typography.caption, color: c.textMuted, marginBottom: spacing.xs },
  quoteText: { ...typography.caption, color: c.textSecondary, lineHeight: 18 },

  formatBar: {
    borderTopWidth: 1,
    borderTopColor: c.border,
    backgroundColor: c.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  formatActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  formatBtn: {
    width: componentSizes.buttonMd,
    height: componentSizes.buttonMd,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  });
}
