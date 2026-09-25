import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Check, Users } from 'lucide-react-native';
import type { ContactCard } from '../../api/types';
import {
  getContactDisplayName,
  getContactPrimaryEmail,
  getContactPhotoRef,
  getPrimaryOrg,
  isGroup,
} from '../../lib/contact-utils';
import SenderAvatar from '../SenderAvatar';
import ContactPhoto from './ContactPhoto';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';

interface ContactListRowProps {
  contact: ContactCard;
  onPress?: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  selectionMode?: boolean;
  secondaryText?: string;
}

export default function ContactListRow({
  contact,
  onPress,
  onLongPress,
  selected,
  selectionMode,
  secondaryText,
}: ContactListRowProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const name = getContactDisplayName(contact) || t('contacts.unnamed', 'Unnamed');
  const email = getContactPrimaryEmail(contact);
  const org = getPrimaryOrg(contact);
  const photo = getContactPhotoRef(contact);
  const group = isGroup(contact);

  const subtitle = secondaryText ?? (email || org);
  const tertiary = email && org && org !== name ? org : undefined;
  // Also what a photo shows while it downloads (Stalwart 1.0 blobs) or when
  // it can't be loaded. The card's own photo is the only one it may show.
  const fallbackAvatar = group ? (
    <View style={styles.groupAvatar}>
      <Users size={18} color={c.primary} />
    </View>
  ) : (
    <SenderAvatar name={name} email={email} size={componentSizes.avatarMd} photo={null} />
  );

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole={selectionMode ? 'checkbox' : 'button'}
      accessibilityState={selectionMode ? { checked: !!selected } : undefined}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.rowPressed,
        selected && styles.rowSelected,
      ]}
    >
      {selectionMode && (
        <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
          {selected && <Check size={14} color={c.primaryForeground} />}
        </View>
      )}

      {photo ? (
        <ContactPhoto photo={photo} style={styles.avatarImage} fallback={fallbackAvatar} />
      ) : fallbackAvatar}

      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>{name}</Text>
        {!!subtitle && (
          <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
        )}
        {!!tertiary && (
          <Text style={styles.tertiary} numberOfLines={1}>{tertiary}</Text>
        )}
      </View>
    </Pressable>
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
  rowSelected: { backgroundColor: c.primaryBg },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radius.xs,
    borderWidth: 2,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  avatarImage: {
    width: componentSizes.avatarMd,
    height: componentSizes.avatarMd,
    borderRadius: componentSizes.avatarMd / 2,
    backgroundColor: c.surface,
  },
  groupAvatar: {
    width: componentSizes.avatarMd,
    height: componentSizes.avatarMd,
    borderRadius: componentSizes.avatarMd / 2,
    backgroundColor: c.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { flex: 1, minWidth: 0 },
  name: { ...typography.bodyMedium, color: c.text },
  subtitle: { ...typography.caption, color: c.textMuted, marginTop: 1 },
  tertiary: { ...typography.small, color: c.textSecondary, marginTop: 1 },
  });
}
