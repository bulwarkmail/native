import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import {
  Folder, Inbox, Send, FileText, Trash, ShieldAlert, Archive,
} from 'lucide-react-native';
import { SettingsSection, SettingItem } from './settings-section';
import { colors, spacing, radius, typography } from '../../theme/tokens';
import { useEmailStore } from '../../stores/email-store';
import type { Mailbox } from '../../api/types';

const ROLE_LABEL: Record<string, string> = {
  inbox: 'Inbox', drafts: 'Drafts', sent: 'Sent', trash: 'Trash',
  junk: 'Junk', archive: 'Archive', important: 'Important', all: 'All',
};
const ROLE_ICON: Record<string, any> = {
  inbox: Inbox, drafts: FileText, sent: Send, trash: Trash,
  junk: ShieldAlert, archive: Archive,
};

function getIcon(mb: Mailbox) {
  if (mb.role && ROLE_ICON[mb.role]) return ROLE_ICON[mb.role];
  return Folder;
}

export function FolderSettings() {
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const fetchMailboxes = useEmailStore((s) => s.fetchMailboxes);

  useEffect(() => {
    if (mailboxes.length === 0) void fetchMailboxes();
  }, [mailboxes.length, fetchMailboxes]);

  const sorted = [...mailboxes].sort((a, b) => {
    const ar = a.role ? 0 : 1;
    const br = b.role ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name);
  });

  const totalUnread = mailboxes.reduce((sum, m) => sum + (m.unreadEmails ?? 0), 0);

  return (
    <View style={styles.container}>
      <SettingsSection
        title="Folders"
        description={`Your mail folders. ${mailboxes.length} folder${mailboxes.length === 1 ? '' : 's'}, ${totalUnread} unread.`}
      >
        {mailboxes.length === 0 ? (
          <View style={styles.loading}>
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        ) : (
          <View>
            {sorted.map((mb) => {
              const Icon = getIcon(mb);
              return (
                <View key={mb.id} style={styles.folderRow}>
                  <View style={styles.folderLeft}>
                    <Icon
                      size={16}
                      color={mb.role ? colors.primary : colors.mutedForeground}
                    />
                    <Text style={styles.folderName} numberOfLines={1}>{mb.name}</Text>
                    {mb.role && ROLE_LABEL[mb.role] && (
                      <View style={styles.rolePill}>
                        <Text style={styles.rolePillText}>{ROLE_LABEL[mb.role]}</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.folderRight}>
                    {mb.unreadEmails > 0 && (
                      <View style={styles.unreadBadge}>
                        <Text style={styles.unreadText}>{mb.unreadEmails}</Text>
                      </View>
                    )}
                    <Text style={styles.total}>{mb.totalEmails}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </SettingsSection>

      <SettingsSection
        title="Management"
        description="Creating, renaming and deleting folders is not yet available in the mobile app. Use the web client."
      >
        <SettingItem label="Read-only">
          <Text style={styles.caption}>Folder list shown above is live.</Text>
        </SettingItem>
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xxxl },
  loading: { paddingVertical: 40, alignItems: 'center' },
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
  },
  folderLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  folderName: { ...typography.body, color: colors.text, flexShrink: 1 },
  rolePill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: colors.primaryBg,
  },
  rolePillText: { fontSize: 10, fontWeight: '500', color: colors.primary },
  folderRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  unreadBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
  },
  unreadText: { fontSize: 10, fontWeight: '500', color: colors.primaryForeground },
  total: { ...typography.caption, color: colors.mutedForeground, minWidth: 32, textAlign: 'right' },
  caption: { ...typography.caption, color: colors.mutedForeground },
});
