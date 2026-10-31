import { File as FileIcon, FileArchive, FileImage, FileSpreadsheet, FileText } from '../icons';
import type { ThemePalette } from '../../theme/tokens';
import type { AttachmentKind } from '../../lib/list-attachments';

/**
 * The icon of an attachment chip by file type, the same in the list and the
 * reader (webmail components/email/attachment-chips.tsx, a78d03a18).
 */
export const ATTACHMENT_ICONS: Record<AttachmentKind, typeof FileIcon> = {
  image: FileImage,
  pdf: FileText,
  sheet: FileSpreadsheet,
  archive: FileArchive,
  document: FileText,
  other: FileIcon,
};

/** The icon's colour by file type. */
export function attachmentIconColor(kind: AttachmentKind, c: ThemePalette): string {
  switch (kind) {
    case 'image': return c.tags.purple.dot;
    case 'pdf': return c.tags.red.dot;
    case 'sheet': return c.tags.green.dot;
    case 'archive': return c.tags.amber.dot;
    case 'document': return c.tags.blue.dot;
    default: return c.textMuted;
  }
}
