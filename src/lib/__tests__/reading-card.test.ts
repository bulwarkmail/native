import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ useWindowDimensions: () => ({ width: 1180, height: 820 }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
import fs from 'node:fs';
import path from 'node:path';
import { READING_CARD_GUTTER, READING_CARD_MAX_WIDTH, showsReadingCard } from '../mail-reading';
import { layoutFor } from '../use-layout';
import { buildBodyDocument } from '../email-body-document';
import { SETTINGS_KEY_MAP, SYNCED_SETTING_KEYS, mergeWithDefaults } from '../../stores/settings-store';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('reading card', () => {
  it('frames the message like the webmail and Fastmail: the pane less 20 a side, at most 882 wide', () => {
    expect(READING_CARD_MAX_WIDTH).toBe(882);
    expect(READING_CARD_GUTTER).toBe(20);
  });

  it('shows on a tablet with the comfortable reading width', () => {
    expect(showsReadingCard('comfortable', layoutFor(1180, 820))).toBe(true);
    expect(showsReadingCard('comfortable', layoutFor(820, 1180))).toBe(true);
    expect(showsReadingCard('comfortable', layoutFor(744, 1133))).toBe(true);
  });

  it('never shows on a phone, upright or on its side', () => {
    expect(showsReadingCard('comfortable', layoutFor(393, 852))).toBe(false);
    expect(showsReadingCard('comfortable', layoutFor(932, 430))).toBe(false);
  });

  it('leaves full width as it was', () => {
    expect(showsReadingCard('full', layoutFor(1180, 820))).toBe(false);
  });

  it('keeps the webmail setting name and values, so the choice syncs between devices', () => {
    expect(SYNCED_SETTING_KEYS).toContain('readingWidth');
    expect(SETTINGS_KEY_MAP.readingWidth).toBeUndefined();
    expect(mergeWithDefaults({}).readingWidth).toBe('full');
    expect(mergeWithDefaults({ readingWidth: 'comfortable' }).readingWidth).toBe('comfortable');
    expect(mergeWithDefaults({ readingWidth: 'narrow' } as never).readingWidth).toBe('full');
  });

  it('lets the message body fill the card, and keeps its own cap at full width', () => {
    const base = {
      key: 'k', emptyLabel: '-', blockRemoteImages: false, cidMap: {}, isDark: false,
      messageSpacing: 'auto' as const, plainTextFont: 'sans' as const, quoteLabels: { show: 's', hide: 'h' },
    };
    const html = { ...base, rawHtml: '<p>Hi</p>', text: null };
    const plain = { ...base, rawHtml: null, text: 'Hi' };
    expect(buildBodyDocument(html).html).toContain('max-width: 720px');
    expect(buildBodyDocument(plain).html).toContain('max-width: 80ch');
    expect(buildBodyDocument({ ...html, fillWidth: true }).html).not.toContain('max-width: 720px');
    expect(buildBodyDocument({ ...plain, fillWidth: true }).html).not.toContain('max-width: 80ch');
  });

  it('is wired into the message screen and offered in Settings only where it shows', () => {
    const screen = read('screens/EmailThreadScreen.tsx');
    expect(screen).toMatch(/const readingCard = showsReadingCard\(readingWidth, layout\);/);
    expect(screen).toMatch(/style=\{readingCard \? styles\.readingCard : styles\.paneFill\}/);
    expect(screen).toMatch(/fillWidth=\{readingCard\}/);
    const settings = read('components/settings/AccessibilitySettings.tsx');
    expect(settings).toMatch(/\{isSplit && \(\s*<SettingItem\s+label=\{t\('settings\.accessibility\.reading_width\.label', 'Reading width'\)\}/);
  });
});
