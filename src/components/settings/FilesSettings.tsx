import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  Folder, FileText, FileCode, FileAudio, File, Image as ImageIcon,
} from 'lucide-react-native';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';
import { colors, spacing, radius, typography } from '../../theme/tokens';

type FolderLayout = 'inline' | 'sidebar';
type ViewMode = 'list' | 'grid';
type SortKey = 'name' | 'size' | 'modified';
type SortDir = 'asc' | 'desc';

interface FilesPrefs {
  folderLayout: FolderLayout;
  defaultViewMode: ViewMode;
  defaultSortKey: SortKey;
  defaultSortDir: SortDir;
  showIcons: boolean;
  coloredIcons: boolean;
  showThumbnails: boolean;
  showHiddenFiles: boolean;
}

const DEFAULTS: FilesPrefs = {
  folderLayout: 'inline',
  defaultViewMode: 'list',
  defaultSortKey: 'name',
  defaultSortDir: 'asc',
  showIcons: true,
  coloredIcons: true,
  showThumbnails: true,
  showHiddenFiles: false,
};

interface SampleFile {
  name: string;
  isFolder: boolean;
  size: number;
  modified: string;
  hidden?: boolean;
}

const SAMPLE: SampleFile[] = [
  { name: 'Documents',   isFolder: true,  size: 0, modified: '03-10' },
  { name: 'Photos',      isFolder: true,  size: 0, modified: '03-14' },
  { name: 'report.pdf',  isFolder: false, size: 245000, modified: '03-15' },
  { name: 'notes.md',    isFolder: false, size: 1200, modified: '03-12' },
  { name: 'song.mp3',    isFolder: false, size: 5200000, modified: '03-01' },
  { name: '.config',     isFolder: false, size: 340, modified: '02-20', hidden: true },
];

function formatSize(b: number) {
  if (b === 0) return '-';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function getIcon(file: SampleFile, colored: boolean, sz: number) {
  if (file.isFolder) return <Folder size={sz} color={colored ? '#60a5fa' : colors.mutedForeground} />;
  const ext = file.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg': case 'png': case 'gif':
      return <ImageIcon size={sz} color={colored ? '#4ade80' : colors.mutedForeground} />;
    case 'mp3': case 'wav':
      return <FileAudio size={sz} color={colored ? '#a78bfa' : colors.mutedForeground} />;
    case 'pdf':
      return <FileText size={sz} color={colored ? '#f87171' : colors.mutedForeground} />;
    case 'md': case 'json': case 'js': case 'ts':
      return <FileCode size={sz} color={colored ? '#fbbf24' : colors.mutedForeground} />;
    default:
      return <File size={sz} color={colors.mutedForeground} />;
  }
}

function FilesPreview({ prefs }: { prefs: FilesPrefs }) {
  const files = SAMPLE.filter((f) => {
    if (!prefs.showHiddenFiles && f.hidden) return false;
    return true;
  }).sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    let cmp = 0;
    if (prefs.defaultSortKey === 'name') cmp = a.name.localeCompare(b.name);
    if (prefs.defaultSortKey === 'size') cmp = a.size - b.size;
    if (prefs.defaultSortKey === 'modified') cmp = a.modified.localeCompare(b.modified);
    return prefs.defaultSortDir === 'desc' ? -cmp : cmp;
  });

  if (prefs.defaultViewMode === 'grid') {
    return (
      <View style={styles.previewBox}>
        <View style={styles.gridWrap}>
          {files.map((f) => (
            <View key={f.name} style={[styles.gridItem, f.hidden && { opacity: 0.5 }]}>
              {prefs.showIcons ? getIcon(f, prefs.coloredIcons, 24) : <View style={{ width: 24, height: 24 }} />}
              <Text style={styles.gridName} numberOfLines={1}>{f.name}</Text>
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.previewBox}>
      <View style={styles.listHeader}>
        <Text style={[styles.listHeaderText, { flex: 1 }]}>Name</Text>
        <Text style={[styles.listHeaderText, { width: 60, textAlign: 'right' }]}>Size</Text>
        <Text style={[styles.listHeaderText, { width: 60, textAlign: 'right' }]}>Modified</Text>
      </View>
      {files.map((f) => (
        <View key={f.name} style={[styles.listRow, f.hidden && { opacity: 0.5 }]}>
          {prefs.showIcons && getIcon(f, prefs.coloredIcons, 14)}
          <Text
            style={[styles.listName, f.isFolder && { fontWeight: '500' }]}
            numberOfLines={1}
          >
            {f.name}
          </Text>
          <Text style={styles.listMeta}>{formatSize(f.size)}</Text>
          <Text style={styles.listMeta}>{f.modified}</Text>
        </View>
      ))}
    </View>
  );
}

export function FilesSettings() {
  const [prefs, setPrefs] = useState<FilesPrefs>(DEFAULTS);
  const update = (patch: Partial<FilesPrefs>) => setPrefs((p) => ({ ...p, ...patch }));

  return (
    <View style={styles.container}>
      <View>
        <Text style={styles.previewLabel}>Preview</Text>
        <FilesPreview prefs={prefs} />
      </View>

      <SettingsSection title="Display" description="How files and folders are presented.">
        <SettingItem label="Folder layout" description="Choose how folders appear in the browser.">
          <RadioGroup
            value={prefs.folderLayout}
            onChange={(v) => update({ folderLayout: v as FolderLayout })}
            options={[
              { value: 'inline', label: 'Inline' },
              { value: 'sidebar', label: 'Sidebar' },
            ]}
          />
        </SettingItem>

        <SettingItem label="Default view" description="List or grid view.">
          <RadioGroup
            value={prefs.defaultViewMode}
            onChange={(v) => update({ defaultViewMode: v as ViewMode })}
            options={[
              { value: 'list', label: 'List' },
              { value: 'grid', label: 'Grid' },
            ]}
          />
        </SettingItem>

        <SettingItem label="Default sort" description="Primary sort key.">
          <RadioGroup
            value={prefs.defaultSortKey}
            onChange={(v) => update({ defaultSortKey: v as SortKey })}
            options={[
              { value: 'name', label: 'Name' },
              { value: 'size', label: 'Size' },
              { value: 'modified', label: 'Modified' },
            ]}
          />
        </SettingItem>

        <SettingItem label="Sort direction">
          <RadioGroup
            value={prefs.defaultSortDir}
            onChange={(v) => update({ defaultSortDir: v as SortDir })}
            options={[
              { value: 'asc', label: 'Ascending' },
              { value: 'desc', label: 'Descending' },
            ]}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title="Icons" description="Appearance of file and folder icons.">
        <SettingItem label="Show icons" description="Display icons for files and folders.">
          <ToggleSwitch checked={prefs.showIcons} onChange={(v) => update({ showIcons: v })} />
        </SettingItem>
        <SettingItem label="Colored icons" description="Use file-type-specific colors.">
          <ToggleSwitch
            checked={prefs.coloredIcons}
            onChange={(v) => update({ coloredIcons: v })}
            disabled={!prefs.showIcons}
          />
        </SettingItem>
        <SettingItem label="Show thumbnails" description="Generate previews for images.">
          <ToggleSwitch checked={prefs.showThumbnails} onChange={(v) => update({ showThumbnails: v })} />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title="Behavior">
        <SettingItem label="Show hidden files" description="Include dotfiles (.name) in listings.">
          <ToggleSwitch
            checked={prefs.showHiddenFiles}
            onChange={(v) => update({ showHiddenFiles: v })}
          />
        </SettingItem>
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xxxl },
  previewLabel: { ...typography.bodyMedium, color: colors.text, marginBottom: spacing.sm },
  previewBox: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    overflow: 'hidden',
    minHeight: 160,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.muted,
  },
  listHeaderText: { fontSize: 10, fontWeight: '500', color: colors.mutedForeground },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  listName: { fontSize: 11, color: colors.text, flex: 1 },
  listMeta: { fontSize: 10, color: colors.mutedForeground, width: 60, textAlign: 'right' },
  gridWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    padding: spacing.sm,
  },
  gridItem: {
    alignItems: 'center',
    gap: 4,
    padding: spacing.sm,
    width: 72,
    borderRadius: radius.sm,
  },
  gridName: { fontSize: 9, color: colors.text, textAlign: 'center' },
});
