type Translate = (key: string, fallback?: string) => string;

/**
 * A sharee the server shows no name for (Stalwart 1.0 with directory queries
 * off). One wording everywhere: Settings > Sharing (lib/delegation/display)
 * said "Unknown person", the folder and file share sheets "Unknown user".
 */
export function unknownPersonLabel(t: Translate): string {
  return t('delegates.unknown_person', 'Unknown person');
}
