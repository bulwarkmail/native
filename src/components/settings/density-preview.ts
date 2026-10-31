import type { Density } from '../../stores/settings-store';

// The sample rows under Settings > Appearance > Density. They showed a
// preview line whenever the density had room for one, even with "Show
// preview text" off, so the sample didn't look like the list (webmail
// c166651d1).

const DENSITY_PREVIEW: Record<Density, { py: number; gap: number; showAvatar: boolean; showPreview: boolean }> = {
  'extra-compact': { py: 2, gap: 6, showAvatar: false, showPreview: false },
  compact: { py: 4, gap: 8, showAvatar: true, showPreview: false },
  regular: { py: 10, gap: 12, showAvatar: true, showPreview: true },
  comfortable: { py: 16, gap: 16, showAvatar: true, showPreview: true },
};

export function densityPreviewConfig(density: Density, showPreviewSetting: boolean) {
  const cfg = DENSITY_PREVIEW[density] ?? DENSITY_PREVIEW.regular;
  return { ...cfg, showPreview: cfg.showPreview && showPreviewSetting };
}
