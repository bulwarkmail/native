import { describe, it, expect, vi, beforeEach } from 'vitest';

// Toasts, the Undo bar and the offline banner were never read out on iOS:
// they relied on accessibilityLiveRegion, which only Android honours.

const { platform, announceWithOptions, announcePlain } = vi.hoisted(() => ({
  platform: { OS: 'ios' as 'ios' | 'android' },
  announceWithOptions: vi.fn(),
  announcePlain: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: platform,
  AccessibilityInfo: {
    announceForAccessibility: announcePlain,
    announceForAccessibilityWithOptions: announceWithOptions,
  },
}));

import { announceConnectivity, resetAnnouncements, toastAnnouncement } from '../announce';
import { toast, useToastStore } from '../../stores/toast-store';

beforeEach(() => {
  vi.clearAllMocks();
  platform.OS = 'ios';
  resetAnnouncements();
  useToastStore.getState().clearToasts();
});

describe('toast announcements', () => {
  it('reads a toast out on iOS, title and message as one sentence', () => {
    toast.success('Draft saved', 'In Drafts');
    expect(announceWithOptions).toHaveBeenCalledWith('Draft saved. In Drafts', { queue: true });
  });

  it('lets an error interrupt', () => {
    toast.error('Could not send');
    expect(announceWithOptions).toHaveBeenCalledWith('Could not send', { queue: false });
  });

  it('says the same toast once within a couple of seconds', () => {
    toast.info('Copied');
    toast.info('Copied');
    expect(announceWithOptions).toHaveBeenCalledTimes(1);
  });

  it('leaves Android to the live region', () => {
    platform.OS = 'android';
    toast.success('Draft saved');
    expect(announceWithOptions).not.toHaveBeenCalled();
    expect(announcePlain).not.toHaveBeenCalled();
  });

  it('names the action', () => {
    expect(toastAnnouncement({ title: 'Archived', actionLabel: 'Undo' })).toBe('Archived. Undo');
    expect(toastAnnouncement({ title: 'Done!', message: 'All read' })).toBe('Done! All read');
  });
});

describe('offline announcement', () => {
  it('says the drop once, however many banners see it', () => {
    announceConnectivity(true, 'You are offline');
    announceConnectivity(false, 'You are offline');
    announceConnectivity(false, 'You are offline');
    expect(announceWithOptions).toHaveBeenCalledTimes(1);
    expect(announceWithOptions).toHaveBeenCalledWith('You are offline', { queue: false });
  });

  it('says it again after the connection came back and went again', () => {
    announceConnectivity(false, 'You are offline');
    announceConnectivity(true, 'You are offline');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    announceConnectivity(false, 'You are offline');
    expect(announceWithOptions).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
