import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  Folder, FileText, FileCode, FileAudio, File, Image as ImageIcon,
} from 'lucide-react-native';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  useSettingsStore,
  type FilesFolderLayout,
  type FilesViewMode,
  type FilesSortKey,
  type FilesSortDir,
} from '../../stores/settings-store';

interface FilesPrefs {
  folderLayout: FilesFolderLayout;
  defaultViewMode: FilesViewMode;
  defaultSortKey: FilesSortKey;
  defaultSortDir: FilesSortDir;
  showIcons: boolean;
  coloredIcons: boolean;
  showThumbnails: boolean;
  showHiddenFiles: boolean;
}

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

function getIcon(c: ThemePalette, file: SampleFile, colored: boolean, sz: number) {
  if (file.isFolder) return <Folder size={sz} color={colored ? '#60a5fa' : c.mutedForeground} />;
  const ext = file.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg': case 'png': case 'gif':
      return <ImageIcon size={sz} color={colored ? '#4ade80' : c.mutedForeground} />;
    case 'mp3': case 'wav':
      return <FileAudio size={sz} color={colored ? '#a78bfa' : c.mutedForeground} />;
    case 'pdf':
      return <FileText size={sz} color={colored ? '#f87171' : c.mutedForeground} />;
    case 'md': case 'json': case 'js': case 'ts':
      return <FileCode size={sz} color={colored ? '#fbbf24' : c.mutedForeground} />;
    default:
      return <File size={sz} color={c.mutedForeground} />;
  }
}

function FilesPreview({ prefs }: { prefs: FilesPrefs }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
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
              {prefs.showIcons ? getIcon(c, f, prefs.coloredIcons, 24) : <View style={{ width: 24, height: 24 }} />}
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
          {prefs.showIcons && getIcon(c, f, prefs.coloredIcons, 14)}
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
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const set = useSettingsStore((s) => s.updateSetting);

  const folderLayout = useSettingsStore((s) => s.filesFolderLayout);
  const defaultViewMode = useSettingsStore((s) => s.filesDefaultViewMode);
  const defaultSortKey = useSettingsStore((s) => s.filesDefaultSortKey);
  const defaultSortDir = useSettingsStore((s) => s.filesDefaultSortDir);
  const showIcons = useSettingsStore((s) => s.filesShowIcons);
  const coloredIcons = useSettingsStore((s) => s.filesColoredIcons);
  const showThumbnails = useSettingsStore((s) => s.filesShowThumbnails);
  const showHiddenFiles = useSettingsStore((s) => s.filesShowHiddenFiles);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const prefs: FilesPrefs = {
    folderLayout,
    defaultViewMode,
    defaultSortKey,
    defaultSortDir,
    showIcons,
    coloredIcons,
    showThumbnails,
    showHiddenFiles,
  };

  return (
    <View style={styles.container}>
      <View>
        <Text style={styles.previewLabel}>Preview</Text>
        <FilesPreview prefs={prefs} />
      </View>

      <SettingsSection title="Display" description="How files and folders are presented.">
        <SettingItem label="Folder layout" description="Choose how folders appear in the browser.">
          <RadioGroup
            value={folderLayout}
            onChange={(v) => set('filesFolderLayout', v as FilesFolderLayout)}
            options={[
              { value: 'inline', label: 'Inline' },
              { value: 'sidebar', label: 'Sidebar' },
            ]}
          />
        </SettingItem>

        <SettingItem label="Default view" description="List or grid view.">
          <RadioGroup
            value={defaultViewMode}
            onChange={(v) => set('filesDefaultViewMode', v as FilesViewMode)}
            options={[
              { value: 'list', label: 'List' },
              { value: 'grid', label: 'Grid' },
            ]}
          />
        </SettingItem>

        <SettingItem label="Default sort" description="Primary sort key.">
          <RadioGroup
            value={defaultSortKey}
            onChange={(v) => set('filesDefaultSortKey', v as FilesSortKey)}
            options={[
              { value: 'name', label: 'Name' },
              { value: 'size', label: 'Size' },
              { value: 'modified', label: 'Modified' },
            ]}
          />
        </SettingItem>

        <SettingItem label="Sort direction">
          <RadioGroup
            value={defaultSortDir}
            onChange={(v) => set('filesDefaultSortDir', v as FilesSortDir)}
            options={[
              { value: 'asc', label: 'Ascending' },
              { value: 'desc', label: 'Descending' },
            ]}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title="Icons" description="Appearance of file and folder icons.">
        <SettingItem label="Show icons" description="Display icons for files and folders.">
          <ToggleSwitch checked={showIcons} onChange={(v) => set('filesShowIcons', v)} />
        </SettingItem>
        <SettingItem label="Colored icons" description="Use file-type-specific colors.">
          <ToggleSwitch
            checked={coloredIcons}
            onChange={(v) => set('filesColoredIcons', v)}
            disabled={!showIcons}
          />
        </SettingItem>
        <SettingItem label="Show thumbnails" description="Generate previews for images.">
          <ToggleSwitch
            checked={showThumbnails}
            onChange={(v) => set('filesShowThumbnails', v)}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title="Behavior">
        <SettingItem label="Show hidden files" description="Include dotfiles (.name) in listings.">
          <ToggleSwitch
            checked={showHiddenFiles}
            onChange={(v) => set('filesShowHiddenFiles', v)}
          />
        </SettingItem>
      </SettingsSection>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { gap: spacing.xxxl },
  previewLabel: { ...typography.bodyMedium, color: c.text, marginBottom: spacing.sm },
  previewBox: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.background,
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
    borderBottomColor: c.border,
    backgroundColor: c.muted,
  },
  listHeaderText: { fontSize: 10, fontWeight: '500', color: c.mutedForeground },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  listName: { fontSize: 11, color: c.text, flex: 1 },
  listMeta: { fontSize: 10, color: c.mutedForeground, width: 60, textAlign: 'right' },
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
  gridName: { fontSize: 9, color: c.text, textAlign: 'center' },
});
}
