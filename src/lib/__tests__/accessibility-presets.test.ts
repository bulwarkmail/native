import { describe, it, expect } from 'vitest';
import { mergeWithDefaults, type PersistedSettings } from '../../stores/settings-store';
import { FONT_SCALE } from '../../theme/dynamic';
import { applyPresetChanges, presetChanges, undoPresetChanges } from '../accessibility-presets';

// Settings > Accessibility (webmail 1.19, 8008393e5, 0731d24f6): presets that
// set several options at once and can be undone, and text size from 87.5%
// to 200% (the app had 92/100/112%).

function store(initial: Partial<PersistedSettings>) {
  const state: Partial<PersistedSettings> = { ...initial };
  const update = <K extends keyof PersistedSettings>(key: K, value: PersistedSettings[K]) => {
    state[key] = value;
  };
  return { state, update };
}

describe('accessibility presets', () => {
  it('changes only what differs, and Undo puts it back', () => {
    const { state, update } = store({ fontSize: 'medium', showToolbarLabels: true, animationsEnabled: true });
    const changes = presetChanges('low-vision', state);
    expect(changes).toEqual([{ key: 'fontSize', from: 'medium', to: 'xx-large' }]);

    applyPresetChanges(changes, update);
    expect(state.fontSize).toBe('xx-large');
    undoPresetChanges(changes, state, update);
    expect(state.fontSize).toBe('medium');
  });

  it('keeps a value the user changed again after applying', () => {
    const { state, update } = store({ animationsEnabled: true });
    const changes = presetChanges('motion', state);
    applyPresetChanges(changes, update);
    expect(state.animationsEnabled).toBe(false);
    state.animationsEnabled = true;
    state.fontSize = 'huge';
    undoPresetChanges(changes, state, update);
    expect(state.animationsEnabled).toBe(true);
  });

  it('turns off conversation grouping for screen readers', () => {
    expect(presetChanges('screen-reader', { disableThreading: false })).toEqual([
      { key: 'disableThreading', from: false, to: true },
    ]);
    expect(presetChanges('screen-reader', { disableThreading: true })).toEqual([]);
  });
});

describe('text size', () => {
  it('runs from 87.5% to 200%', () => {
    expect(FONT_SCALE.small).toBe(0.875);
    expect(FONT_SCALE.huge).toBe(2);
    expect(Object.keys(FONT_SCALE)).toHaveLength(7);
  });

  it('keeps the larger sizes and the notification duration when the settings are read back', () => {
    const merged = mergeWithDefaults({ fontSize: 'huge', toastDuration: 20 } as Partial<PersistedSettings>);
    expect(merged.fontSize).toBe('huge');
    expect(merged.toastDuration).toBe(20);
    expect(mergeWithDefaults({ toastDuration: 7 } as Partial<PersistedSettings>).toastDuration).toBe(-1);
  });
});
