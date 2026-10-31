import { describe, it, expect } from 'vitest';
import { densityPreviewConfig } from '../settings/density-preview';

describe('density sample', () => {
  it('shows preview lines only when "Show preview text" is on (webmail c166651d1)', () => {
    expect(densityPreviewConfig('regular', true).showPreview).toBe(true);
    expect(densityPreviewConfig('regular', false).showPreview).toBe(false);
    expect(densityPreviewConfig('comfortable', false).showPreview).toBe(false);
    // Compact densities have no room for one either way.
    expect(densityPreviewConfig('compact', true).showPreview).toBe(false);
  });
});
