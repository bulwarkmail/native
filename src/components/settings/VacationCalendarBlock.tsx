import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { SettingItem, ToggleSwitch } from './settings-section';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { usePolicyStore } from '../../stores/policy-store';
import { useVacationStore } from '../../stores/vacation-store';
import { useVacationCalendarStore } from '../../stores/vacation-calendar-store';
import { jmapClient } from '../../api/jmap-client';
import { getCalendars } from '../../api/calendar';
import { blockCalendar, resolveBlockSetting, vacationBlockChanged } from '../../lib/vacation-calendar';

/**
 * "Block my calendar" under the out-of-office dates (lib/vacation-calendar.ts;
 * webmail components/settings/vacation-calendar-block.tsx): on by default,
 * lockable by the organisation (vacationBlockCalendar). Shown once both
 * dates are set. For a managed account the event goes into that account's
 * calendar, which the user needs write access to.
 */
export function VacationCalendarBlock({ hasDates, accountId }: { hasDates: boolean; accountId?: string }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const setting = useVacationCalendarStore((s) => s.block);
  const setBlock = useVacationCalendarStore((s) => s.setBlock);
  const restriction = usePolicyStore((s) => s.effective?.restrictions?.vacationBlockCalendar);
  const policyDefault = usePolicyStore((s) => s.effective?.defaults?.vacationBlockCalendar);
  const { value: checked, locked, hidden } = resolveBlockSetting(restriction, policyDefault, setting);
  const supported = jmapClient.hasCapability('urn:ietf:params:jmap:calendars');
  const [access, setAccess] = React.useState<{ key: string; ok: boolean } | null>(null);
  const key = accountId ?? '';

  React.useEffect(() => {
    if (!supported || !hasDates) return undefined;
    let cancelled = false;
    void getCalendars()
      .then((calendars) => !!blockCalendar(calendars, accountId ?? jmapClient.accountId, jmapClient.accountId))
      // Not knowing is no reason to hide the option.
      .catch(() => true)
      .then((ok) => { if (!cancelled) setAccess({ key, ok }); });
    return () => { cancelled = true; };
  }, [supported, hasDates, accountId, key]);

  if (!supported || !hasDates || hidden) return null;
  if (access?.key === key && !access.ok) {
    return (
      <Text style={styles.note}>
        {accountId
          ? t('vacation_calendar.no_access_managed', 'The calendar of this account can’t be blocked: you don’t have write access to it.')
          : t('vacation_calendar.no_calendar', 'Your calendar can’t be blocked: Bulwark found no calendar to add the event to.')}
      </Text>
    );
  }

  const onChange = (next: boolean) => {
    setBlock(next);
    const { isEnabled, fromDate, toDate, subject } = useVacationStore.getState();
    vacationBlockChanged(accountId, { isEnabled, fromDate, toDate, subject });
  };

  return (
    <SettingItem
      label={t('vacation_calendar.label', 'Block my calendar')}
      description={t('vacation_calendar.description', 'Adds a busy event for the time you’re away, so nobody books meetings with you then.')}
      locked={locked}
    >
      <ToggleSwitch
        checked={checked}
        onChange={onChange}
        disabled={locked}
        accessibilityLabel={t('vacation_calendar.label', 'Block my calendar')}
      />
    </SettingItem>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    note: { ...typography.caption, color: c.mutedForeground, paddingVertical: spacing.sm },
  });
}
