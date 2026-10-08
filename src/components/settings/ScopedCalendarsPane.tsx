import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Pencil } from 'lucide-react-native';
import type { Calendar } from '../../api/types';
import { SettingsSection } from './settings-section';
import { CalendarEditSheet } from '../calendar/CalendarEditSheet';
import { useCalendarStore } from '../../stores/calendar-store';
import { useEmailStore } from '../../stores/email-store';
import { useLocaleStore } from '../../stores/locale-store';
import { getCalendarColor } from '../../lib/calendar-utils';
import { scopedCalendars, scopedCalendarActions, updateScopedCalendar } from '../../lib/managed-scope';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

interface ScopedCalendarsPaneProps {
  /** JMAP id of the shared/group account Settings manages. */
  managedAccountId: string;
}

/**
 * The Calendar pane of Settings scoped to a shared/group account (webmail:
 * CalendarManagementSettings in scoped mode): that account's calendars, to
 * rename and recolour where the rights allow it. Nothing is created or
 * deleted here.
 */
export function ScopedCalendarsPane({ managedAccountId }: ScopedCalendarsPaneProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const calendars = useCalendarStore((s) => s.calendars);
  const fetchCalendars = useCalendarStore((s) => s.fetchCalendars);
  // The app account the pane opened in: every save is for it, and refused once another is shown.
  const [appAccountId] = React.useState(() => useEmailStore.getState().activeAccountId);
  const [editing, setEditing] = React.useState<Calendar | null>(null);

  const shared = React.useMemo(() => scopedCalendars(calendars, managedAccountId), [calendars, managedAccountId]);

  React.useEffect(() => {
    if (useCalendarStore.getState().calendars.length === 0) void fetchCalendars();
  }, [fetchCalendars]);

  return (
    <>
      <SettingsSection
        title={t('calendar.management.title', 'Calendar Management')}
        description={t('settings.scoped.calendars_description', 'Rename and recolor the calendars of this account.')}
      >
        {shared.length === 0 ? (
          <Text style={styles.empty}>{t('settings.scoped.no_calendars', 'This account has no calendars you can see.')}</Text>
        ) : shared.map((cal) => {
          const { edit } = scopedCalendarActions(cal);
          return (
            <View key={cal.id} style={styles.row}>
              <View style={[styles.swatch, { backgroundColor: getCalendarColor(cal) }]} />
              <Text style={styles.name} numberOfLines={1}>{cal.name}</Text>
              {edit && (
                <Pressable
                  onPress={() => setEditing(cal)}
                  hitSlop={6}
                  style={styles.iconBtn}
                  accessibilityRole="button"
                  accessibilityLabel={t('calendar.management.edit', 'Edit')}
                >
                  <Pencil size={15} color={c.textSecondary} />
                </Pressable>
              )}
            </View>
          );
        })}
      </SettingsSection>

      <CalendarEditSheet
        visible={editing !== null}
        calendar={editing}
        onSave={async (values) => {
          if (editing) await updateScopedCalendar({ appAccountId, managedAccountId }, editing.id, values);
        }}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    swatch: { width: 14, height: 14, borderRadius: radius.full },
    name: { ...typography.body, color: c.text, flex: 1, minWidth: 0 },
    empty: { ...typography.body, color: c.textMuted, paddingVertical: spacing.sm },
    iconBtn: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
  });
}
