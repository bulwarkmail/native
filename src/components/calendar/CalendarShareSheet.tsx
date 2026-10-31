import React from 'react';
import type { Calendar, CalendarRights } from '../../api/types';
import { useLocaleStore } from '../../stores/locale-store';
import { ShareCollectionSheet, type SharePreset } from '../sharing/ShareCollectionSheet';

type RolePreset = 'freeBusy' | 'read' | 'readWrite' | 'manager';

// Same presets the webmail's share-collection dialog offers for calendars.
export const CALENDAR_PRESETS: Record<RolePreset, CalendarRights> = {
  freeBusy: {
    mayReadFreeBusy: true, mayReadItems: false, mayWriteAll: false, mayWriteOwn: false,
    mayUpdatePrivate: false, mayRSVP: false, mayShare: false, mayDelete: false,
  },
  read: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: false, mayWriteOwn: false,
    mayUpdatePrivate: false, mayRSVP: false, mayShare: false, mayDelete: false,
  },
  readWrite: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
    mayUpdatePrivate: true, mayRSVP: true, mayShare: false, mayDelete: false,
  },
  manager: {
    mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
    mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
  },
};

interface CalendarShareSheetProps {
  calendar: Calendar | null;
  onShare: (calendarId: string, principalId: string, rights: CalendarRights | null) => Promise<void>;
  onClose: () => void;
}

// JMAP sharing for an owned calendar: pick a principal, choose a role.
export function CalendarShareSheet({ calendar, onShare, onClose }: CalendarShareSheetProps) {
  const t = useLocaleStore((s) => s.t);
  // The webmail's sharing presets (same rights, same names).
  const presets = React.useMemo<SharePreset<CalendarRights>[]>(() => [
    { key: 'freeBusy', label: t('sharing.preset.freeBusy', 'Free/busy only'), rights: CALENDAR_PRESETS.freeBusy },
    { key: 'read', label: t('sharing.preset.read', 'Read only'), rights: CALENDAR_PRESETS.read },
    { key: 'readWrite', label: t('sharing.preset.readWrite', 'Read & write'), rights: CALENDAR_PRESETS.readWrite },
    { key: 'manager', label: t('sharing.preset.manager', 'Manager'), rights: CALENDAR_PRESETS.manager },
  ], [t]);
  return (
    <ShareCollectionSheet
      collection={calendar}
      presets={presets}
      addRights={CALENDAR_PRESETS.read}
      onShare={onShare}
      onClose={onClose}
    />
  );
}
