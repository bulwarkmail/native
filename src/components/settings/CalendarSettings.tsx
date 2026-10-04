import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SettingsSection, SettingItem, Select, RadioGroup, ToggleSwitch } from './settings-section';
import {
  useSettingsStore,
  type CalendarView,
  type FirstDayOfWeek,
  type TimeFormat,
} from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { useColors } from '../../theme/colors';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { formatDisplayHour } from '../../lib/calendar-display-range';
import { AUTO_TIME_ZONE, getDeviceTimeZone, isValidTimeZone } from '../../lib/calendar-timezone';
import { deviceSyncAvailable } from '../../device-sync/app/available';
import { CALENDAR_AUTHORITY } from '../../device-sync/types';
import { DeviceSyncSection } from './device-sync/DeviceSyncSection';

// A compact list of IANA zones for the picker (#755). The device zone and
// any previously stored value are always offered too.
const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DAY_SHORT_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const COMMON_TIME_ZONES = [
  'UTC',
  'Europe/London', 'Europe/Dublin', 'Europe/Lisbon',
  'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam',
  'Europe/Brussels', 'Europe/Vienna', 'Europe/Zurich', 'Europe/Prague', 'Europe/Warsaw',
  'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Helsinki', 'Europe/Riga',
  'Europe/Kyiv', 'Europe/Athens', 'Europe/Istanbul', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
  'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Bogota',
  'America/Lima', 'America/Santiago', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
  'Asia/Dubai', 'Asia/Tehran', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok',
  'Asia/Jakarta', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Taipei',
  'Asia/Seoul', 'Asia/Tokyo', 'Australia/Perth', 'Australia/Adelaide', 'Australia/Sydney',
  'Pacific/Auckland',
];

export function CalendarSettings() {
  const t = useLocaleStore((s) => s.t);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const update = useSettingsStore((s) => s.updateSetting);

  const viewMode = useSettingsStore((s) => s.calendarDefaultView);
  const firstDay = useSettingsStore((s) => s.calendarFirstDayOfWeek);
  const timeFormat = useSettingsStore((s) => s.calendarTimeFormat);
  const timeZone = useSettingsStore((s) => s.calendarTimeZone);
  const showTimeInMonth = useSettingsStore((s) => s.calendarShowTimeInMonth);
  const showWeekNumbers = useSettingsStore((s) => s.calendarShowWeekNumbers);
  const freeScroll = useSettingsStore((s) => s.calendarFreeScroll);
  const limitHours = useSettingsStore((s) => s.calendarLimitHours);
  const dayStartHour = useSettingsStore((s) => s.calendarDayStartHour);
  const dayEndHour = useSettingsStore((s) => s.calendarDayEndHour);
  const hideNonWorkingDays = useSettingsStore((s) => s.calendarHideNonWorkingDays);
  const workingDays = useSettingsStore((s) => s.calendarWorkingDays);
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const birthdayCal = useSettingsStore((s) => s.showBirthdayCalendar);
  const tasksEnabled = useSettingsStore((s) => s.enableCalendarTasks);
  const showTasksOnCal = useSettingsStore((s) => s.showTasksOnCalendar);

  // Android with the native module only (#34).
  const deviceSync = React.useMemo(() => deviceSyncAvailable(), []);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const deviceZone = getDeviceTimeZone();
  const timeZoneOptions = React.useMemo(() => {
    const zones = new Set<string>([deviceZone, ...COMMON_TIME_ZONES]);
    if (timeZone && timeZone !== AUTO_TIME_ZONE && isValidTimeZone(timeZone)) zones.add(timeZone);
    return [
      {
        value: AUTO_TIME_ZONE,
        label: t('calendar.settings.time_zone_auto_zone', 'Device time zone ({zone})', { zone: deviceZone }),
      },
      ...[...zones].sort().map((z) => ({ value: z, label: z.replace(/_/g, ' ') })),
    ];
  }, [deviceZone, timeZone, t]);

  // Visible hours: the end list only offers hours after the start, and
  // moving the start past the end pushes the end along.
  const hourOptions = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      value: String(from + i),
      label: formatDisplayHour(from + i, timeFormat),
    }));
  const setStartHour = (hour: number) => {
    update('calendarDayStartHour', hour);
    if (dayEndHour <= hour) update('calendarDayEndHour', hour + 1);
  };

  // Working days in the order the user's week runs.
  const weekOrder = Array.from({ length: 7 }, (_, i) => (firstDay + i) % 7);
  const toggleWorkingDay = (day: number) => {
    const current = new Set(workingDays);
    if (current.has(day)) {
      // The week view needs at least one day to show.
      if (current.size === 1) return;
      current.delete(day);
    } else {
      current.add(day);
    }
    update('calendarWorkingDays', [...current].sort((a, b) => a - b));
  };

  return (
    <>
      <SettingsSection title={t('calendar.settings.title', 'Calendar')}>
        <SettingItem label={t('calendar.settings.default_view', 'Default view')}>
          <Select
            value={viewMode}
            onChange={(v) => update('calendarDefaultView', v as CalendarView)}
            options={[
              { value: 'month', label: t('calendar.views.month', 'Month') },
              { value: 'week', label: t('calendar.views.week', 'Week') },
              { value: 'day', label: t('calendar.views.day', 'Day') },
              { value: 'agenda', label: t('calendar.views.agenda', 'Agenda') },
            ]}
          />
        </SettingItem>

        <SettingItem label={t('calendar.settings.week_starts_on', 'Week starts on')}>
          <Select
            value={String(firstDay)}
            onChange={(v) => update('calendarFirstDayOfWeek', Number(v) as FirstDayOfWeek)}
            options={[
              { value: '1', label: t('calendar.days.monday', 'Monday') },
              { value: '6', label: t('calendar.days.saturday', 'Saturday') },
              { value: '0', label: t('calendar.days.sunday', 'Sunday') },
            ]}
          />
        </SettingItem>

        <SettingItem label={t('calendar.settings.time_format', 'Time format')}>
          <RadioGroup
            value={timeFormat}
            onChange={(v) => update('calendarTimeFormat', v as TimeFormat)}
            options={[
              { value: '12h', label: t('calendar.settings.time_format_12h', '12-hour') },
              { value: '24h', label: t('calendar.settings.time_format_24h', '24-hour') },
            ]}
          />
        </SettingItem>

        <SettingItem
          label={t('calendar.settings.time_zone', 'Time zone')}
          description={t(
            'calendar.settings.time_zone_desc',
            'Zone used for new events and for interpreting the calendar. "Device" follows the phone.',
          )}
        >
          <Select
            value={timeZone || AUTO_TIME_ZONE}
            onChange={(v) => update('calendarTimeZone', v)}
            options={timeZoneOptions}
          />
        </SettingItem>

        <SettingItem
          label={t('calendar.settings.show_time_in_month_view', 'Show time in month view')}
          description={t(
            'calendar.settings.show_time_in_month_view_desc',
            'Display event times in the month calendar view. On small screens this shows full event entries instead of dots.',
          )}
        >
          <ToggleSwitch
            checked={showTimeInMonth}
            onChange={(v) => update('calendarShowTimeInMonth', v)}
          />
        </SettingItem>

        <SettingItem
          label={t('calendar.settings.show_week_numbers', 'Show week numbers')}
          description={t('calendar.settings.show_week_numbers_mobile_desc', 'Display week numbers in the month view.')}
        >
          <ToggleSwitch
            checked={showWeekNumbers}
            onChange={(v) => update('calendarShowWeekNumbers', v)}
          />
        </SettingItem>

        <SettingItem
          label={t('calendar.settings.calendar_free_scroll', 'Free scrolling')}
          description={t(
            'calendar.settings.calendar_free_scroll_desc',
            'Scroll continuously through months, weeks and days instead of one period at a time',
          )}
        >
          <ToggleSwitch
            checked={freeScroll}
            onChange={(v) => update('calendarFreeScroll', v)}
          />
        </SettingItem>

        <SettingItem
          label={t('calendar.settings.limit_hours', 'Limit visible hours')}
          description={t(
            'calendar.settings.limit_hours_desc',
            'Show only these hours in the day and week views. Events outside them stay reachable from the arrows at the top and bottom of each day.',
          )}
        >
          <ToggleSwitch checked={limitHours} onChange={(v) => update('calendarLimitHours', v)} />
        </SettingItem>

        {limitHours && (
          <SettingItem label={t('calendar.settings.visible_hours', 'Visible hours')}>
            <View style={styles.hoursRow}>
              <Select
                value={String(dayStartHour)}
                onChange={(v) => setStartHour(Number(v))}
                accessibilityLabel={t('calendar.settings.visible_hours_start', 'Start of visible hours')}
                options={hourOptions(0, 23)}
              />
              <Text style={styles.hoursDash}>–</Text>
              <Select
                value={String(dayEndHour)}
                onChange={(v) => update('calendarDayEndHour', Number(v))}
                accessibilityLabel={t('calendar.settings.visible_hours_end', 'End of visible hours')}
                options={hourOptions(Math.min(23, dayStartHour) + 1, 24)}
              />
            </View>
          </SettingItem>
        )}

        <SettingItem
          label={t('calendar.settings.hide_non_working_days', 'Hide non-working days')}
          description={t(
            'calendar.settings.hide_non_working_days_desc',
            "Leave the days you don't work out of the week view. Their events still show in the month, day and agenda views.",
          )}
        >
          <ToggleSwitch
            checked={hideNonWorkingDays}
            onChange={(v) => update('calendarHideNonWorkingDays', v)}
          />
        </SettingItem>

        {hideNonWorkingDays && (
          <SettingItem label={t('calendar.settings.working_days', 'Working days')}>
            <View style={styles.dayChips} accessibilityRole="toolbar">
              {weekOrder.map((day) => {
                const selected = workingDays.includes(day);
                const name = t(`calendar.days.${DAY_KEYS[day]}`, DAY_NAMES[day]);
                return (
                  <Pressable
                    key={day}
                    accessibilityRole="button"
                    accessibilityLabel={name}
                    accessibilityState={{ selected }}
                    onPress={() => toggleWorkingDay(day)}
                    style={[styles.dayChip, selected && styles.dayChipSelected]}
                  >
                    <Text style={[styles.dayChipText, selected && styles.dayChipTextSelected]}>
                      {t(`calendar.days.${DAY_SHORT_KEYS[day]}`, DAY_SHORT_NAMES[day])}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </SettingItem>
        )}

        <SettingItem
          label={t('calendar.settings.show_birthday_calendar', 'Contact birthday calendar')}
          description={t(
            'calendar.settings.show_birthday_calendar_desc',
            'Show a virtual calendar with birthdays from your contacts',
          )}
        >
          <ToggleSwitch
            checked={birthdayCal}
            onChange={(v) => update('showBirthdayCalendar', v)}
          />
        </SettingItem>

        <SettingItem
          label={t('calendar.settings.enable_tasks', 'Enable tasks')}
          description={t('calendar.settings.enable_tasks_desc', 'Show a tasks view in the calendar for managing to-dos')}
        >
          <ToggleSwitch
            checked={tasksEnabled}
            onChange={(v) => update('enableCalendarTasks', v)}
          />
        </SettingItem>

        {tasksEnabled && (
          <SettingItem
            label={t('calendar.settings.show_tasks_on_calendar', 'Show tasks on calendar')}
            description={t(
              'calendar.settings.show_tasks_on_calendar_desc',
              'Display task chips on the day and week calendar views',
            )}
          >
            <ToggleSwitch
              checked={showTasksOnCal}
              onChange={(v) => update('showTasksOnCalendar', v)}
            />
          </SettingItem>
        )}
      </SettingsSection>

      {deviceSync && (
        <DeviceSyncSection
          authority={CALENDAR_AUTHORITY}
          title={t('calendar.settings.device_sync_title', 'Sync to this device')}
          description={t(
            'calendar.settings.device_sync_desc',
            'Show your calendars in the Calendar app and other apps on this device. Changes sync both ways.',
          )}
        />
      )}
    </>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    hoursRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    hoursDash: { ...typography.body, color: c.textMuted },
    dayChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    dayChip: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: 8,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    dayChipSelected: { backgroundColor: c.primary, borderColor: c.primary },
    dayChipText: { ...typography.small, color: c.text },
    dayChipTextSelected: { color: c.textInverse, fontWeight: '600' },
  });
}
