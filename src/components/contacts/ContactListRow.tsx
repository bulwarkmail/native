import React from 'react';
import { View, Text, StyleSheet, Pressable, Image } from 'react-native';
import { Check, Users } from 'lucide-react-native';
import type { ContactCard } from '../../api/types';
import {
  getContactDisplayName,
  getContactPrimaryEmail,
  getContactPhotoUri,
  getPrimaryOrg,
  isGroup,
} from '../../lib/contact-utils';
import SenderAvatar from '../SenderAvatar';
import { colors, spacing, radius, typography, componentSizes } from '../../theme/tokens';

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
  const name = getContactDisplayName(contact) || 'Unnamed';
  const email = getContactPrimaryEmail(contact);
  const org = getPrimaryOrg(contact);
  const photoUri = getContactPhotoUri(contact);
  const group = isGroup(contact);

  const subtitle = secondaryText ?? (email || org);
  const tertiary = email && org && org !== name ? org : undefined;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.rowPressed,
        selected && styles.rowSelected,
      ]}
    >
      {selectionMode && (
        <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
          {selected && <Check size={14} color={colors.primaryForeground} />}
        </View>
      )}

      {photoUri ? (
        <Image source={{ uri: photoUri }} style={styles.avatarImage} />
      ) : group ? (
        <View style={styles.groupAvatar}>
          <Users size={18} color={colors.primary} />
        </View>
      ) : (
        <SenderAvatar name={name} email={email} size={componentSizes.avatarMd} />
      )}

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

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  rowPressed: { backgroundColor: colors.surfaceHover },
  rowSelected: { backgroundColor: colors.primaryBg },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radius.xs,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  avatarImage: {
    width: componentSizes.avatarMd,
    height: componentSizes.avatarMd,
    borderRadius: componentSizes.avatarMd / 2,
    backgroundColor: colors.surface,
  },
  groupAvatar: {
    width: componentSizes.avatarMd,
    height: componentSizes.avatarMd,
    borderRadius: componentSizes.avatarMd / 2,
    backgroundColor: colors.primaryBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { flex: 1, minWidth: 0 },
  name: { ...typography.bodyMedium, color: colors.text },
  subtitle: { ...typography.caption, color: colors.textMuted, marginTop: 1 },
  tertiary: { ...typography.small, color: colors.textSecondary, marginTop: 1 },
});
