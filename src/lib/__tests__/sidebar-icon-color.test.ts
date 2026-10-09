import { describe, it, expect } from 'vitest';
import { roleIconColor } from '../sidebar-icon-color';

const c = { text: '#text', textSecondary: '#secondary', textMuted: '#muted' };

describe('roleIconColor', () => {
  it('tints role icons only when colourful is on', () => {
    expect(roleIconColor('inbox', false, true, c)).toBe('#60a5fa');
    expect(roleIconColor('inbox', false, false, c)).toBe(c.textSecondary);
    expect(roleIconColor('inbox', true, false, c)).toBe(c.text);
    expect(roleIconColor('trash', false, true, c)).toBe(c.textMuted);
  });

  it('shows a plain trash icon when colourful is off', () => {
    expect(roleIconColor('trash', false, false, c)).toBe(c.textSecondary);
    expect(roleIconColor('trash', true, false, c)).toBe(c.text);
  });

  it('uses the text colours for folders without a tinted role', () => {
    expect(roleIconColor(null, false, true, c)).toBe(c.textSecondary);
    expect(roleIconColor(undefined, true, true, c)).toBe(c.text);
    expect(roleIconColor('shared', false, true, c)).toBe(c.textSecondary);
  });
});
