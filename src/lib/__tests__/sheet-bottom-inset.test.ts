import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A Modal on Android is an edge-to-edge window the keyboard doesn't resize
// (and an iOS Modal never resizes), so the keyboard covered sheet inputs and
// their buttons: the New folder name and Save, the tag picker's "New tag"
// field, the Files new-folder prompt. useSheetBottomInset pads a sheet by the
// keyboard's overlap while it is open; full-screen modals pad their body by
// the part above the safe-area inset (useModalKeyboardPadding).

type Listener = (e: unknown) => void;
const keyboardListeners = new Map<string, Listener>();
let keyboardVisible = false;
let keyboardMetrics: { screenY: number; height: number } | undefined;
let os = 'android';
let safeBottom = 0;

vi.mock('react-native', () => ({
  Dimensions: {
    get: () => ({ width: 800, height: 1280 }),
    addEventListener: () => ({ remove() {} }),
  },
  Keyboard: {
    addListener: (name: string, fn: Listener) => {
      keyboardListeners.set(name, fn);
      return { remove() { keyboardListeners.delete(name); } };
    },
    isVisible: () => keyboardVisible,
    metrics: () => keyboardMetrics,
    dismiss: vi.fn(),
  },
  get Platform() {
    return { OS: os };
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: safeBottom }),
}));

// Just enough React to run the hook: one state slot that survives re-runs.
let state = 0;
vi.mock('react', () => ({
  default: {
    useState: (initial: number) => [state ?? initial, (v: number) => { state = v; }],
    useRef: <T,>(v: T) => ({ current: v }),
    useEffect: (fn: () => void) => { fn(); },
  },
}));

import {
  modalKeyboardPadding, sheetBottomInset, useModalKeyboardPadding, useSheetBottomInset,
} from '../sheet-bottom-inset';

beforeEach(() => {
  keyboardListeners.clear();
  keyboardVisible = false;
  keyboardMetrics = undefined;
  os = 'android';
  safeBottom = 0;
  state = 0;
});

describe('sheetBottomInset', () => {
  it('keeps the navigation bar or taskbar clear without a keyboard', () => {
    expect(sheetBottomInset(60, 0)).toBe(60);
  });

  it('keeps the keyboard clear while it is open', () => {
    expect(sheetBottomInset(24, 324)).toBe(324);
  });
});

describe('modalKeyboardPadding', () => {
  it('adds the part of the keyboard above the safe-area inset on Android', () => {
    expect(modalKeyboardPadding(324, 24, 'android')).toBe(300);
    expect(modalKeyboardPadding(0, 24, 'android')).toBe(0);
  });

  it('leaves iOS to its KeyboardAvoidingView', () => {
    expect(modalKeyboardPadding(324, 34, 'ios')).toBe(0);
  });
});

describe('useSheetBottomInset', () => {
  it('pads by the taskbar, then by the keyboard while it is open', () => {
    safeBottom = 60;
    expect(useSheetBottomInset(true)).toBe(60);
    // Tablet: 1280 tall, keyboard top at 880.
    keyboardListeners.get('keyboardDidShow')!({ endCoordinates: { screenY: 880, height: 340 } });
    expect(useSheetBottomInset(true)).toBe(400);
    keyboardListeners.get('keyboardDidHide')!({});
    expect(useSheetBottomInset(true)).toBe(60);
  });

  it('uses a keyboard that is already open when the sheet opens', () => {
    keyboardVisible = true;
    keyboardMetrics = { screenY: 980, height: 300 };
    useSheetBottomInset(true); // the effect reads the open keyboard
    expect(useSheetBottomInset(true)).toBe(300);
  });

  it('follows the iOS frame events', () => {
    os = 'ios';
    safeBottom = 34;
    useSheetBottomInset(true);
    keyboardListeners.get('keyboardWillChangeFrame')!({ endCoordinates: { screenY: 944, height: 336 } });
    expect(useSheetBottomInset(true)).toBe(336);
  });

  it("doesn't listen while the sheet is closed", () => {
    safeBottom = 24;
    expect(useSheetBottomInset(false)).toBe(24);
    expect(keyboardListeners.size).toBe(0);
  });
});

describe('useModalKeyboardPadding', () => {
  it('ends a full-screen modal body above the keyboard', () => {
    safeBottom = 24;
    expect(useModalKeyboardPadding(true)).toBe(0);
    keyboardListeners.get('keyboardDidShow')!({ endCoordinates: { screenY: 956, height: 300 } });
    expect(useModalKeyboardPadding(true)).toBe(300);
  });
});

// The sheets and dialogs with a text field in the files this fix covers.
const SRC = path.resolve(__dirname, '../..');
const WITH_INPUTS = [
  'components/Dialog.tsx',
  'components/TagSheet.tsx',
  'components/TemplateSheet.tsx',
  'components/files/ShareSheet.tsx',
  'components/filters/FilterRuleModal.tsx',
  'components/filters/SieveEditorSheet.tsx',
  'components/settings/ContentSendersSettings.tsx',
  'components/settings/DelegateDialog.tsx',
  'components/settings/FolderSettings.tsx',
  'components/settings/IdentitySettings.tsx',
  'components/settings/TemplateSettings.tsx',
  'screens/FilesScreen.tsx',
];

function modalBodies(source: string): string[] {
  const out: string[] = [];
  const re = /<(SafeAreaModal|Modal)[\s>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const end = source.indexOf(`</${m[1]}>`, m.index);
    out.push(source.slice(m.index, end < 0 ? undefined : end));
  }
  return out;
}

describe('modals with a text field', () => {
  it('make room for the keyboard', () => {
    for (const rel of WITH_INPUTS) {
      const bodies = modalBodies(fs.readFileSync(path.join(SRC, rel), 'utf8'))
        .filter((b) => /<(TextInput|Input|NewTagRow)\b/.test(b));
      expect(bodies.length, rel).toBeGreaterThan(0);
      for (const body of bodies) expect(/bottomInset|keyboardPadding/.test(body), rel).toBe(true);
    }
  });
});
