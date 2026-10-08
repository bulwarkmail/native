import { describe, it, expect } from 'vitest';
import {
  ADDRESS_BOOK_PRESETS,
  CALENDAR_PRESETS,
  detectPreset,
  MAILBOX_PRESETS,
  presetOrder,
} from '../share-presets';

describe('share presets', () => {
  it('keeps the calendar presets the calendar share sheet offered', () => {
    expect(CALENDAR_PRESETS).toEqual({
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
    });
  });

  it('offers the webmail\'s address book presets', () => {
    expect(ADDRESS_BOOK_PRESETS).toEqual({
      read: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
      readWrite: { mayRead: true, mayWrite: true, mayShare: false, mayDelete: false },
      manager: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
    });
  });

  it('orders the presets per kind; address books have no free/busy', () => {
    expect(presetOrder('calendar')).toEqual(['freeBusy', 'read', 'readWrite', 'manager']);
    expect(presetOrder('addressBook')).toEqual(['read', 'readWrite', 'manager']);
  });

  it('detects each calendar preset, and anything else as custom', () => {
    for (const p of presetOrder('calendar')) {
      expect(detectPreset('calendar', CALENDAR_PRESETS[p])).toBe(p);
    }
    expect(detectPreset('calendar', { ...CALENDAR_PRESETS.read, mayRSVP: true })).toBe('custom');
  });

  it('detects each address book preset, and anything else as custom', () => {
    for (const p of presetOrder('addressBook')) {
      expect(detectPreset('addressBook', ADDRESS_BOOK_PRESETS[p as 'read'])).toBe(p);
    }
    expect(detectPreset('addressBook', { mayRead: true, mayWrite: false, mayShare: true, mayDelete: false }))
      .toBe('custom');
    expect(detectPreset('addressBook', {})).toBe('custom');
  });

  it('counts a missing right as false', () => {
    expect(detectPreset('addressBook', { mayRead: true })).toBe('read');
    expect(detectPreset('addressBook', { mayRead: true, mayWrite: true })).toBe('readWrite');
    expect(detectPreset('calendar', { mayReadFreeBusy: true })).toBe('freeBusy');
  });

  it('offers webmail\'s three folder presets and detects them', () => {
    expect(MAILBOX_PRESETS).toEqual({
      read: {
        mayReadItems: true, mayAddItems: false, mayRemoveItems: false, maySetSeen: true,
        maySetKeywords: false, mayCreateChild: false, mayRename: false, mayDelete: false,
        maySubmit: false, mayShare: false,
      },
      readWrite: {
        mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
        maySetKeywords: true, mayCreateChild: false, mayRename: false, mayDelete: false,
        maySubmit: false, mayShare: false,
      },
      manager: {
        mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true,
        maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true,
        maySubmit: true, mayShare: true,
      },
    });
    expect(presetOrder('mailbox')).toEqual(['read', 'readWrite', 'manager']);
    for (const p of presetOrder('mailbox')) {
      expect(detectPreset('mailbox', MAILBOX_PRESETS[p as 'read'])).toBe(p);
    }
    expect(detectPreset('mailbox', { ...MAILBOX_PRESETS.read, maySetKeywords: true })).toBe('custom');
    // A server that leaves mayShare out still reads as the preset.
    const { mayShare: _omit, ...readWithoutShare } = MAILBOX_PRESETS.read;
    expect(detectPreset('mailbox', readWithoutShare)).toBe('read');
  });
});

