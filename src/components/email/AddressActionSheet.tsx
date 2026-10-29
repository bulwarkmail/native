import React from 'react';
import { Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import { Copy, PenSquare, UserRound, UserRoundPlus } from '../icons';
import type { EmailAddress } from '../../api/types';
import type { RootStackParamList } from '../../navigation/types';
import { useContactsStore } from '../../stores/contacts-store';
import { useLocaleStore } from '../../stores/locale-store';
import { useColors } from '../../theme/colors';
import { ActionSheet, type ActionSheetItem } from './ActionSheet';

type Nav = NativeStackNavigationProp<RootStackParamList>;

interface Props {
  address: EmailAddress | null;
  onClose: () => void;
}

/**
 * Tap sheet for a sender/recipient: copy the address, start a message to it,
 * open the matching contact or add one (the webmail's RecipientPopover).
 */
export function AddressActionSheet({ address, onClose }: Props) {
  const c = useColors();
  const t = useLocaleStore((s) => s.t);
  const navigation = useNavigation<Nav>();
  const findContactByEmail = useContactsStore((s) => s.findContactByEmail);

  const email = address?.email ?? '';
  const contact = React.useMemo(() => (email ? findContactByEmail(email) : undefined), [email, findContactByEmail]);

  const items: ActionSheetItem[] = [
    {
      key: 'copy',
      label: t('email_viewer.address_actions.copy', 'Copy address'),
      icon: <Copy size={18} color={c.textSecondary} />,
      onPress: () => {
        onClose();
        void Clipboard.setStringAsync(email).catch(() => {
          Alert.alert(t('common.error', 'Error'), t('email_viewer.address_actions.copy_failed', 'Could not copy the address.'));
        });
      },
    },
    {
      key: 'compose',
      label: t('email_viewer.address_actions.compose', 'New message'),
      icon: <PenSquare size={18} color={c.textSecondary} />,
      onPress: () => {
        onClose();
        navigation.navigate('Compose', { prefillTo: [{ email, name: address?.name }] });
      },
    },
    contact
      ? {
          key: 'contact',
          label: t('email_viewer.view_contact', 'View contact'),
          icon: <UserRound size={18} color={c.textSecondary} />,
          onPress: () => {
            onClose();
            navigation.navigate('ContactDetail', { contactId: contact.id });
          },
        }
      : {
          key: 'add',
          label: t('email_viewer.address_actions.add_contact', 'Add to contacts'),
          icon: <UserRoundPlus size={18} color={c.textSecondary} />,
          onPress: () => {
            onClose();
            navigation.navigate('ContactForm', { prefill: { email, name: address?.name } });
          },
        },
  ];

  return (
    <ActionSheet
      visible={!!address}
      title={address?.name || email}
      subtitle={address?.name ? email : undefined}
      items={items}
      onClose={onClose}
    />
  );
}
