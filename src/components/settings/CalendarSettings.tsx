import React, { useEffect } from 'react';
import { SettingsSection, SettingItem, Select, RadioGroup, ToggleSwitch } from './settings-section';
import {
  useSettingsStore,
  type CalendarView,
  type FirstDayOfWeek,
  type TimeFormat,
  type CalendarHoverPreview,
} from '../../stores/settings-store';

export function CalendarSettings() {
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const update = useSettingsStore((s) => s.updateSetting);

  const viewMode = useSettingsStore((s) => s.calendarDefaultView);
  const firstDay = useSettingsStore((s) => s.calendarFirstDayOfWeek);
  const timeFormat = useSettingsStore((s) => s.calendarTimeFormat);
  const showTimeInMonth = useSettingsStore((s) => s.calendarShowTimeInMonth);
  const showWeekNumbers = useSettingsStore((s) => s.calendarShowWeekNumbers);
  const hoverPreview = useSettingsStore((s) => s.calendarHoverPreview);
  const birthdayCal = useSettingsStore((s) => s.showBirthdayCalendar);
  const tasksEnabled = useSettingsStore((s) => s.enableCalendarTasks);
  const showTasksOnCal = useSettingsStore((s) => s.showTasksOnCalendar);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  return (
    <SettingsSection title="Calendar">
      <SettingItem label="Default view">
        <Select
          value={viewMode}
          onChange={(v) => update('calendarDefaultView', v as CalendarView)}
          options={[
            { value: 'month', label: 'Month' },
            { value: 'week', label: 'Week' },
            { value: 'day', label: 'Day' },
            { value: 'agenda', label: 'Agenda' },
          ]}
        />
      </SettingItem>

      <SettingItem label="Week starts on">
        <Select
          value={String(firstDay)}
          onChange={(v) => update('calendarFirstDayOfWeek', Number(v) as FirstDayOfWeek)}
          options={[
            { value: '1', label: 'Monday' },
            { value: '0', label: 'Sunday' },
          ]}
        />
      </SettingItem>

      <SettingItem label="Time format">
        <RadioGroup
          value={timeFormat}
          onChange={(v) => update('calendarTimeFormat', v as TimeFormat)}
          options={[
            { value: '12h', label: '12-hour' },
            { value: '24h', label: '24-hour' },
          ]}
        />
      </SettingItem>

      <SettingItem
        label="Show time in month view"
        description="Show start times next to events in the month grid."
      >
        <ToggleSwitch
          checked={showTimeInMonth}
          onChange={(v) => update('calendarShowTimeInMonth', v)}
        />
      </SettingItem>

      <SettingItem
        label="Show week numbers"
        description="Display ISO week numbers in month and week views."
      >
        <ToggleSwitch
          checked={showWeekNumbers}
          onChange={(v) => update('calendarShowWeekNumbers', v)}
        />
      </SettingItem>

      <SettingItem
        label="Hover preview"
        description="Show event details on hover or tap-and-hold."
      >
        <Select
          value={hoverPreview}
          onChange={(v) => update('calendarHoverPreview', v as CalendarHoverPreview)}
          options={[
            { value: 'instant', label: 'Instant' },
            { value: 'delay-500ms', label: '500ms delay' },
            { value: 'delay-1s', label: '1s delay' },
            { value: 'delay-2s', label: '2s delay' },
            { value: 'off', label: 'Off' },
          ]}
        />
      </SettingItem>

      <SettingItem
        label="Show birthday calendar"
        description="Automatically include birthdays from your contacts."
      >
        <ToggleSwitch
          checked={birthdayCal}
          onChange={(v) => update('showBirthdayCalendar', v)}
        />
      </SettingItem>

      <SettingItem
        label="Enable tasks"
        description="Show task management alongside events."
      >
        <ToggleSwitch
          checked={tasksEnabled}
          onChange={(v) => update('enableCalendarTasks', v)}
        />
      </SettingItem>

      {tasksEnabled && (
        <SettingItem
          label="Show tasks on calendar"
          description="Overlay tasks with due dates on the calendar."
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
