import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing, TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Star, FileText, Users } from './icons';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useSheetDrag } from '../lib/use-sheet-drag';
import { useLocaleStore } from '../stores/locale-store';
import { useTemplatesStore, type EmailTemplate } from '../stores/templates-store';
import { filterTemplates } from '../lib/template-utils';
import { MODAL_ORIENTATIONS } from '../lib/modal-orientations';
import { useSheetInsets } from '../lib/use-layout';

interface TemplateSheetProps {
  visible: boolean;
  onClose: () => void;
  onPick: (template: EmailTemplate) => void;
}

/**
 * Bottom sheet listing the user's templates for insertion into the composer
 * (webmail template picker): favourites first, then the rest, with a search
 * box over name/subject/category. The templates of the user's group
 * mailboxes follow, each team under its name (Stalwart 1.0 and later).
 */
export function TemplateSheet({ visible, onClose, onPick }: TemplateSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const t = useLocaleStore((s) => s.t);
  const templates = useTemplatesStore((s) => s.templates);
  const hydrated = useTemplatesStore((s) => s.hydrated);
  const hydrate = useTemplatesStore((s) => s.hydrate);
  const teams = useTemplatesStore((s) => s.teams);
  const refresh = useTemplatesStore((s) => s.refresh);
  const [query, setQuery] = React.useState('');
  const slideY = React.useRef(new Animated.Value(500)).current;
  // Centred on a wide window, clear of side insets in landscape.
  const sheetInsets = useSheetInsets();
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({ slideY, closedY: 500, onClose });

  React.useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  React.useEffect(() => {
    if (visible) {
      setQuery('');
      // Templates changed in the webmail or on another device, and the team ones.
      void refresh();
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 500, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, slideY, overlayOpacity]);

  const visibleTemplates = React.useMemo(() => {
    const list = query.trim() ? filterTemplates(templates, query.trim()) : templates;
    return [...list].sort((a, b) => {
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [templates, query]);
  const visibleTeams = React.useMemo(() => teams
    .map((team) => ({
      ...team,
      templates: (query.trim() ? filterTemplates(team.templates, query.trim()) : team.templates)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((team) => team.templates.length > 0), [teams, query]);
  const total = templates.length + teams.reduce((n, team) => n + team.templates.length, 0);

  const renderRow = (template: EmailTemplate, key: string, team?: boolean) => (
    <Pressable
      key={key}
      onPress={() => {
        onPick(template);
        onClose();
      }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.iconWrap}>
        {team
          ? <Users size={16} color={c.textSecondary} />
          : template.isFavorite
            ? <Star size={16} color={c.primary} />
            : <FileText size={16} color={c.textSecondary} />}
      </View>
      <View style={styles.details}>
        <Text style={styles.name} numberOfLines={1}>{template.name}</Text>
        {!!(template.subject || template.category) && (
          <Text style={styles.subject} numberOfLines={1}>
            {[template.category, template.subject].filter(Boolean).join(' · ')}
          </Text>
        )}
      </View>
    </Pressable>
  );

  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.sheetOverlay, { opacity: overlayOpacity }]}>
        <Pressable style={styles.sheetOverlayPress} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom, spacing.md), transform: [{ translateY: slideY }], ...sheetInsets },
        ]}
      >
        <View {...dragHandlers}>
          <View style={styles.sheetHandleHit}>
            <View style={styles.sheetHandle} />
          </View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{t('templates.picker_title', 'Choose a Template')}</Text>
            <Pressable onPress={onClose} hitSlop={10} style={styles.sheetClose}
              accessibilityRole="button"
              accessibilityLabel={t('common.close', 'Close')}
            >
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
        {total > 4 && (
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('templates.search_placeholder', 'Search templates...')}
            placeholderTextColor={c.textMuted}
            style={styles.search}
            autoCorrect={false}
          />
        )}
        <ScrollView style={styles.scrollList} keyboardShouldPersistTaps="handled">
          {visibleTemplates.length === 0 && visibleTeams.length === 0 ? (
            <Text style={styles.empty}>
              {total === 0
                ? t('templates.no_templates', 'No templates yet')
                : t('templates.no_results', 'No templates found')}
            </Text>
          ) : (
            <>
              {visibleTeams.length > 0 && visibleTemplates.length > 0 && (
                <Text style={styles.section}>{t('org_templates.section_personal', 'My templates')}</Text>
              )}
              {visibleTemplates.map((template) => renderRow(template, template.id))}
              {visibleTeams.map((team) => (
                <React.Fragment key={team.accountId}>
                  <Text style={styles.section} numberOfLines={1}>{team.name}</Text>
                  {team.templates.map((template) => renderRow(template, `${team.accountId}|${template.id}`, true))}
                </React.Fragment>
              ))}
            </>
          )}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    sheetOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
    sheetOverlayPress: { flex: 1 },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: '70%',
      backgroundColor: c.popover,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderTopWidth: 1,
      borderColor: c.border,
      paddingTop: spacing.sm,
    },
    sheetHandleHit: { alignItems: 'center', paddingTop: spacing.xs, paddingBottom: spacing.sm },
    sheetHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.border },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    sheetTitle: { ...typography.bodySemibold, color: c.text },
    sheetClose: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.xs },
    search: {
      ...typography.body,
      color: c.text,
      marginHorizontal: spacing.lg,
      marginTop: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: 8,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    scrollList: { paddingVertical: spacing.xs },
    empty: { ...typography.body, color: c.textMuted, textAlign: 'center', padding: spacing.xl },
    section: {
      ...typography.caption,
      color: c.textMuted,
      fontWeight: '600',
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      minHeight: 52,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    iconWrap: {
      marginRight: spacing.md,
      width: 28,
      height: 28,
      borderRadius: radius.xs,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    details: { flex: 1, justifyContent: 'center' },
    name: { ...typography.bodyMedium, color: c.text },
    subject: { ...typography.caption, color: c.textSecondary, marginTop: 2 },
  });
}
