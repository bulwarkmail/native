// The watermark text and layout of the device policy `watermark` (webmail
// lib/watermark.ts, lib/device-policy.ts watermarkText). Drawn by
// components/Watermark.tsx.

/** How many copies of the text the layer holds (rows x columns). */
export const WATERMARK_ROWS = 8;
export const WATERMARK_COLUMNS = 3;

/** The text of the watermark: the user's address and today's date. */
export function watermarkText(address: string, now: Date = new Date(), locale?: string): string {
  let date: string;
  try {
    date = new Intl.DateTimeFormat(locale || undefined, { dateStyle: 'medium' }).format(now);
  } catch {
    date = now.toISOString().slice(0, 10);
  }
  return [address.trim(), date].filter(Boolean).join(' · ');
}
