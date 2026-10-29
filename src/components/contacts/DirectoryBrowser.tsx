import React from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { AlertCircle, BookUser, Lock, Users, MapPin } from '../icons';
import SenderAvatar from '../SenderAvatar';
import { AddressActionSheet } from '../email/AddressActionSheet';
import type { EmailAddress } from '../../api/types';
import { filterDirectory, type DirectoryEntry } from '../../lib/contact-directory';
import { useContactsStore } from '../../stores/contacts-store';
import { useLocaleStore } from '../../stores/locale-store';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

interface DirectoryBrowserProps {
  /** The Contacts search, applied to the directory while it shows. */
  query: string;
}

/**
 * The company directory (#1253, webmail components/contacts/directory-browser
 * .tsx): the people and groups the server lists for this account, read-only.
 * A tap offers to write to the entry or add it to the contacts.
 */
export function DirectoryBrowser({ query }: DirectoryBrowserProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const entries = useContactsStore((s) => s.directory);
  const status = useContactsStore((s) => s.directoryStatus);
  const queriesOff = useContactsStore((s) => s.directoryQueriesOff);
  const fetchDirectory = useContactsStore((s) => s.fetchDirectory);
  const [sheet, setSheet] = React.useState<EmailAddress | null>(null);

  React.useEffect(() => {
    if (status === 'idle') void fetchDirectory();
  }, [status, fetchDirectory]);

  const filtered = React.useMemo(() => filterDirectory(entries, query, locale), [entries, query, locale]);
  const loading = status === 'loading' || status === 'idle';

  const typeLabel = (entry: DirectoryEntry): string | null => {
    if (!entry.type || entry.type === 'individual') return null;
    return t(`contacts.directory.type.${entry.type}`, entry.type);
  };

  let placeholder: React.ReactNode = null;
  if (entries.length === 0) {
    if (loading) {
      placeholder = <ActivityIndicator color={c.primary} />;
    } else if (status === 'unavailable') {
      placeholder = (
        <StatePanel styles={styles} icon={<BookUser size={40} color={c.surfaceActive} />}
          title={t('contacts.directory.unavailable_title', 'No directory')}
          hint={t('contacts.directory.unavailable_hint', "Your mail server doesn't offer a directory of accounts.")} />
      );
    } else if (status === 'restricted') {
      placeholder = (
        <StatePanel styles={styles} icon={<Lock size={40} color={c.surfaceActive} />}
          title={t('contacts.directory.forbidden_title', 'Directory not available')}
          hint={t('contacts.directory.forbidden_hint', "Your mail server doesn't allow this account to browse the directory. Ask your administrator.")} />
      );
    } else if (status === 'error') {
      placeholder = (
        <StatePanel styles={styles} icon={<AlertCircle size={40} color={c.surfaceActive} />}
          title={t('contacts.directory.error_title', "Couldn't load the directory")}
          hint={t('contacts.directory.error_hint', 'Check your connection and try again.')} />
      );
    } else {
      placeholder = (
        <StatePanel styles={styles} icon={<BookUser size={40} color={c.surfaceActive} />}
          title={t('contacts.directory.empty_title', 'The directory is empty')}
          hint={t('contacts.directory.empty_hint', 'Your mail server lists no accounts with an email address.')} />
      );
    }
  } else if (filtered.length === 0) {
    placeholder = (
      <StatePanel styles={styles} icon={<BookUser size={40} color={c.surfaceActive} />}
        title={t('contacts.directory.no_match', 'No one in the directory matches your search')} />
    );
  }

  // Stalwart 1.0 keeps directory queries off unless the administrator turns
  // them on, and then lists only the principals the user already knows.
  const restrictedNote = status === 'restricted' && entries.length > 0
    ? queriesOff
      ? t('contacts.directory.restricted_queries_off', 'Your mail server lists only the accounts you already work with, such as your groups and the people who share with you. An administrator can turn on directory queries to show everyone.')
      : t('contacts.directory.restricted_hint', 'Your mail server lists only the accounts you already work with, such as your groups and the people who share with you.')
    : null;

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={filtered}
        keyExtractor={(e) => e.email.toLowerCase()}
        ListHeaderComponent={restrictedNote ? (
          <View style={styles.note}>
            <Lock size={14} color={c.mutedForeground} />
            <Text style={styles.noteText}>{restrictedNote}</Text>
          </View>
        ) : null}
        renderItem={({ item }) => {
          const kind = typeLabel(item);
          return (
            <Pressable
              onPress={() => setSheet({ name: item.name !== item.email ? item.name : undefined, email: item.email })}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              accessibilityRole="button"
            >
              {item.type === 'group' || item.type === 'location' ? (
                <View style={styles.iconAvatar}>
                  {item.type === 'group'
                    ? <Users size={18} color={c.primary} />
                    : <MapPin size={18} color={c.primary} />}
                </View>
              ) : (
                <SenderAvatar name={item.name} email={item.email} size={componentSizes.avatarMd} photo={null} />
              )}
              <View style={styles.info}>
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.subtitle} numberOfLines={1}>
                  {kind ? `${item.email} · ${kind}` : item.email}
                </Text>
              </View>
            </Pressable>
          );
        }}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={<View style={styles.empty}>{placeholder}</View>}
        refreshControl={
          <RefreshControl refreshing={status === 'loading' && entries.length > 0} onRefresh={() => void fetchDirectory()} tintColor={c.primary} />
        }
        contentContainerStyle={{ flexGrow: 1 }}
      />
      <AddressActionSheet address={sheet} onClose={() => setSheet(null)} />
    </View>
  );
}

function StatePanel({ styles, icon, title, hint }: {
  styles: ReturnType<typeof makeStyles>;
  icon: React.ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <>
      {icon}
      <Text style={styles.emptyTitle}>{title}</Text>
      {!!hint && <Text style={styles.emptyHint}>{hint}</Text>}
    </>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      gap: spacing.md,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    iconAvatar: {
      width: componentSizes.avatarMd,
      height: componentSizes.avatarMd,
      borderRadius: componentSizes.avatarMd / 2,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    info: { flex: 1, minWidth: 0 },
    name: { ...typography.bodyMedium, color: c.text },
    subtitle: { ...typography.caption, color: c.textSecondary, marginTop: 1 },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: spacing.lg },
    note: {
      flexDirection: 'row',
      gap: spacing.sm,
      margin: spacing.lg,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: c.muted,
    },
    noteText: { ...typography.caption, color: c.mutedForeground, flex: 1 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
    emptyTitle: { ...typography.bodyMedium, color: c.text, textAlign: 'center' },
    emptyHint: { ...typography.caption, color: c.mutedForeground, textAlign: 'center' },
  });
}
