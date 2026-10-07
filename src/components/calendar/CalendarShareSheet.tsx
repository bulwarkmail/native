import React from 'react';
import type { Calendar, CalendarRights } from '../../api/types';
import { ShareCollectionSheet } from '../ShareCollectionSheet';

interface CalendarShareSheetProps {
  calendar: Calendar | null;
  onShare: (calendarId: string, principalId: string, rights: CalendarRights | null) => Promise<void>;
  onClose: () => void;
}

// JMAP sharing for an owned calendar (see ShareCollectionSheet).
export function CalendarShareSheet({ calendar, onShare, onClose }: CalendarShareSheetProps) {
  return <ShareCollectionSheet kind="calendar" target={calendar} onShare={onShare} onClose={onClose} />;
}
