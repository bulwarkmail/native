import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FileText, Download, Upload } from 'lucide-react-native';
import { SettingsSection } from './settings-section';
import Button from '../Button';
import { colors, spacing, typography } from '../../theme/tokens';

export function TemplateSettings() {
  const [templates] = useState<{ id: string; name: string }[]>([]);

  return (
    <View style={styles.container}>
      <SettingsSection title="Templates" description="Reusable email templates for common responses.">
        <View style={styles.row}>
          <View style={styles.countRow}>
            <FileText size={16} color={colors.mutedForeground} />
            <Text style={styles.count}>
              {templates.length === 1 ? '1 template' : `${templates.length} templates`}
            </Text>
          </View>
          <Button variant="outline" size="sm">Manage</Button>
        </View>
      </SettingsSection>

      <SettingsSection title="Export / Import" description="Back up or restore your templates.">
        <View style={styles.actions}>
          <Button
            variant="outline"
            size="sm"
            disabled={templates.length === 0}
            icon={<Download size={14} color={colors.text} />}
          >
            Export
          </Button>
          <Button variant="outline" size="sm" icon={<Upload size={14} color={colors.text} />}>
            Import
          </Button>
        </View>
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xxxl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  count: { ...typography.body, color: colors.mutedForeground },
  actions: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.md },
});
