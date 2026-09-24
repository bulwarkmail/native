import React, { useEffect } from 'react';
import { SettingsSection, SettingItem, Select, RadioGroup, ToggleSwitch } from './settings-section';
import {
  useSettingsStore,
  type CalendarView,
  type FirstDayOfWeek,
  type TimeFormat,
} from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { AUTO_TIME_ZONE, getDeviceTimeZone, isValidTimeZone } from '../../lib/calendar-timezone';

// A compact list of IANA zones for the picker (#755). The device zone and
// any previously stored value are always offered too.
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
  const birthdayCal = useSettingsStore((s) => s.showBirthdayCalendar);
  const tasksEnabled = useSettingsStore((s) => s.enableCalendarTasks);
  const showTasksOnCal = useSettingsStore((s) => s.showTasksOnCalendar);

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
        label: `${t('calendar.settings.time_zone_auto', 'Device time zone')} (${deviceZone})`,
      },
      ...[...zones].sort().map((z) => ({ value: z, label: z.replace(/_/g, ' ') })),
    ];
  }, [deviceZone, timeZone, t]);

  // The mobile app has no dedicated day grid ("day" falls back to the
  // agenda), so the option isn't offered; a synced "day" value shows as Agenda.
  const effectiveView: CalendarView = viewMode === 'day' ? 'agenda' : viewMode;

  return (
    <SettingsSection title={t('calendar.settings.title', 'Calendar')}>
      <SettingItem label={t('calendar.settings.default_view', 'Default view')}>
        <Select
          value={effectiveView}
          onChange={(v) => update('calendarDefaultView', v as CalendarView)}
          options={[
            { value: 'month', label: t('calendar.views.month', 'Month') },
            { value: 'week', label: t('calendar.views.week', 'Week') },
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
  );
}
