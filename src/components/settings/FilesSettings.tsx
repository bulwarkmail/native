import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  Folder, FileText, FileCode, FileAudio, File, Image as ImageIcon,
} from 'lucide-react-native';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';
import { spacing, radius, typography, fontPx, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  useSettingsStore,
  type FilesViewMode,
  type FilesSortKey,
  type FilesSortDir,
} from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';

interface FilesPrefs {
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
  const t = useLocaleStore((s) => s.t);
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
        <Text style={[styles.listHeaderText, { flex: 1 }]}>{t('files.name', 'Name')}</Text>
        <Text style={[styles.listHeaderText, { width: 60, textAlign: 'right' }]}>{t('files.size', 'Size')}</Text>
        <Text style={[styles.listHeaderText, { width: 60, textAlign: 'right' }]}>{t('files.modified', 'Modified')}</Text>
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
  const t = useLocaleStore((s) => s.t);

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
        <Text style={styles.previewLabel}>{t('files.preview', 'Preview')}</Text>
        <FilesPreview prefs={prefs} />
      </View>

      <SettingsSection title={t('files.settings_display', 'Display')}>
        <SettingItem
          label={t('files.settings_default_view', 'Default View')}
          description={t('files.settings_default_view_desc', 'Choose between grid and list layout')}
        >
          <RadioGroup
            value={defaultViewMode}
            onChange={(v) => set('filesDefaultViewMode', v as FilesViewMode)}
            options={[
              { value: 'list', label: t('files.list_view', 'List') },
              { value: 'grid', label: t('files.grid_view', 'Grid') },
            ]}
          />
        </SettingItem>

        <SettingItem
          label={t('files.settings_default_sort', 'Default Sort')}
          description={t('files.settings_default_sort_desc', 'Choose the default sorting for files')}
        >
          <RadioGroup
            value={defaultSortKey}
            onChange={(v) => set('filesDefaultSortKey', v as FilesSortKey)}
            options={[
              { value: 'name', label: t('files.name', 'Name') },
              { value: 'size', label: t('files.size', 'Size') },
              { value: 'modified', label: t('files.modified', 'Modified') },
            ]}
          />
        </SettingItem>

        <SettingItem
          label={t('files.settings_sort_direction', 'Sort Direction')}
          description={t('files.settings_sort_direction_desc', 'Choose ascending or descending order')}
        >
          <RadioGroup
            value={defaultSortDir}
            onChange={(v) => set('filesDefaultSortDir', v as FilesSortDir)}
            options={[
              { value: 'asc', label: t('files.settings_ascending', 'Ascending') },
              { value: 'desc', label: t('files.settings_descending', 'Descending') },
            ]}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t('files.settings_icons', 'Icons')}>
        <SettingItem
          label={t('files.settings_show_icons', 'Show File Icons')}
          description={t('files.settings_show_icons_desc', 'Display icons next to files and folders')}
        >
          <ToggleSwitch checked={showIcons} onChange={(v) => set('filesShowIcons', v)} />
        </SettingItem>
        <SettingItem
          label={t('files.settings_colored_icons', 'Colored Icons')}
          description={t('files.settings_colored_icons_desc', 'Use colorful icons instead of monochrome')}
        >
          <ToggleSwitch
            checked={coloredIcons}
            onChange={(v) => set('filesColoredIcons', v)}
            disabled={!showIcons}
          />
        </SettingItem>
        <SettingItem
          label={t('files.settings_show_thumbnails', 'Show Thumbnails')}
          description={t('files.settings_show_thumbnails_desc', 'Display image previews instead of icons for image files')}
        >
          <ToggleSwitch
            checked={showThumbnails}
            onChange={(v) => set('filesShowThumbnails', v)}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t('files.settings_behavior', 'Behavior')}>
        <SettingItem
          label={t('files.settings_show_hidden', 'Show Hidden Files')}
          description={t('files.settings_show_hidden_desc', 'Display files and folders that start with a dot')}
        >
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
  listHeaderText: { fontSize: fontPx(10), fontWeight: '500', color: c.mutedForeground },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  listName: { fontSize: fontPx(11), color: c.text, flex: 1 },
  listMeta: { fontSize: fontPx(10), color: c.mutedForeground, width: 60, textAlign: 'right' },
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
  gridName: { fontSize: fontPx(9), color: c.text, textAlign: 'center' },
});
}
