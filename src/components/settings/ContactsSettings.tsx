import React from 'react';
import { Alert, Share, Text } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Download } from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { useSettingsStore } from '../../stores/settings-store';
import { useContactsStore } from '../../stores/contacts-store';
import { contactsToVCard } from '../../lib/vcard';
import { isGroup } from '../../lib/contact-utils';
import { typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

export function ContactsSettings() {
  const c = useColors();
  const groupByLetter = useSettingsStore((s) => s.groupContactsByLetter);
  const setGroupByLetter = useSettingsStore((s) => s.setGroupContactsByLetter);
  const contacts = useContactsStore((s) => s.contacts);

  const [exporting, setExporting] = React.useState(false);

  const exportable = React.useMemo(() => contacts.filter((c) => !isGroup(c)), [contacts]);
  const exportLabel =
    exportable.length === 0
      ? 'No contacts to export'
      : `Export ${exportable.length} contact${exportable.length === 1 ? '' : 's'} as a single vCard file.`;

  const handleExport = async () => {
    if (exportable.length === 0 || exporting) return;
    setExporting(true);
    try {
      const vcf = contactsToVCard(exportable);
      const filename = `contacts-${new Date().toISOString().slice(0, 10)}.vcf`;
      const path = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(path, vcf);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, {
          mimeType: 'text/vcard',
          UTI: 'public.vcard',
          dialogTitle: 'Export contacts',
        });
      } else {
        await Share.share({ message: vcf });
      }
    } catch (err) {
      Alert.alert('Export failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <SettingsSection
      title="Contacts"
      description="Display preferences and address-book tools."
    >
      <SettingItem
        label="Group by first letter"
        description="Show alphabetical section headers in the contacts list."
      >
        <ToggleSwitch checked={groupByLetter} onChange={setGroupByLetter} />
      </SettingItem>

      <SettingItem
        label="Export contacts"
        description={exportLabel}
      >
        <Button
          variant="outline"
          size="sm"
          icon={<Download size={14} color={c.text} />}
          onPress={() => { void handleExport(); }}
          disabled={exportable.length === 0 || exporting}
          loading={exporting}
        >
          Export
        </Button>
      </SettingItem>

      <SettingItem
        label="Import contacts"
        description="Importing vCard files is currently available on the web client only."
      >
        <Text style={[typography.caption, { color: c.textMuted }]}>Web only</Text>
      </SettingItem>
    </SettingsSection>
  );
}
