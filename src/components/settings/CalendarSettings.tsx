import React, { useState } from 'react';
import { SettingsSection, SettingItem, Select, RadioGroup, ToggleSwitch } from './settings-section';

export function CalendarSettings() {
  const [viewMode, setViewMode] = useState('month');
  const [firstDay, setFirstDay] = useState('1');
  const [timeFormat, setTimeFormat] = useState('24h');
  const [showTimeInMonth, setShowTimeInMonth] = useState(true);
  const [showWeekNumbers, setShowWeekNumbers] = useState(false);
  const [hoverPreview, setHoverPreview] = useState('delay-500ms');
  const [birthdayCal, setBirthdayCal] = useState(true);
  const [tasksEnabled, setTasksEnabled] = useState(false);
  const [showTasksOnCal, setShowTasksOnCal] = useState(true);

  return (
    <SettingsSection title="Calendar">
      <SettingItem label="Default view">
        <Select
          value={viewMode}
          onChange={setViewMode}
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
          value={firstDay}
          onChange={setFirstDay}
          options={[
            { value: '1', label: 'Monday' },
            { value: '0', label: 'Sunday' },
          ]}
        />
      </SettingItem>

      <SettingItem label="Time format">
        <RadioGroup
          value={timeFormat}
          onChange={setTimeFormat}
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
        <ToggleSwitch checked={showTimeInMonth} onChange={setShowTimeInMonth} />
      </SettingItem>

      <SettingItem
        label="Show week numbers"
        description="Display ISO week numbers in month and week views."
      >
        <ToggleSwitch checked={showWeekNumbers} onChange={setShowWeekNumbers} />
      </SettingItem>

      <SettingItem
        label="Hover preview"
        description="Show event details on hover or tap-and-hold."
      >
        <Select
          value={hoverPreview}
          onChange={setHoverPreview}
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
        <ToggleSwitch checked={birthdayCal} onChange={setBirthdayCal} />
      </SettingItem>

      <SettingItem
        label="Enable tasks"
        description="Show task management alongside events."
      >
        <ToggleSwitch checked={tasksEnabled} onChange={setTasksEnabled} />
      </SettingItem>

      {tasksEnabled && (
        <SettingItem
          label="Show tasks on calendar"
          description="Overlay tasks with due dates on the calendar."
        >
          <ToggleSwitch checked={showTasksOnCal} onChange={setShowTasksOnCal} />
        </SettingItem>
      )}
    </SettingsSection>
  );
}
