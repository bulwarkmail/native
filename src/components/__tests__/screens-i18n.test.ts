// Screens and sheets outside Settings and Contacts whose every user-visible
// string goes through t(). A literal English label, alert or JSX text
// sneaking back in stays English in every locale, so this scans the source.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { findUntranslatedLiterals } from './untranslated-literals';

const SRC = join(__dirname, '..', '..');

// File (relative to src/) → texts that stay as they are on purpose.
const TRANSLATED_FILES: Record<string, string[]> = {
  'screens/FilesScreen.tsx': [],
  'components/files/ShareSheet.tsx': [],
  'components/files/FilePreviewModal.tsx': [],
  // The empty date filter shows the input format.
  'screens/EmailListScreen.tsx': ['YYYY-MM-DD'],
  // The link prompt shows an example URL.
  'screens/ComposeScreen.tsx': ['https://example.com'],
  'components/RichTextEditor.tsx': [],
  'screens/LoginScreen.tsx': [],
  // Product name and example host.
  'screens/login/ChooseStep.tsx': ['Bulwark Mail'],
  'screens/login/ConfirmStep.tsx': [],
  'screens/login/EmailStep.tsx': [],
  'screens/login/LoginNotice.tsx': [],
  'screens/login/LoginShell.tsx': ['Bulwark Mobile v'],
  'screens/login/OptionTile.tsx': [],
  'screens/login/PasswordStep.tsx': [],
  'screens/login/ServerStep.tsx': ['mail.example.com'],
  'screens/login/SigningInStep.tsx': [],
  'screens/ScheduledScreen.tsx': [],
  'screens/EmailSourceScreen.tsx': [],
  'components/OfflineBanner.tsx': [],
  'components/OfflineCacheBanner.tsx': [],
  'components/UndoSnackbar.tsx': [],
  'components/UpdateBanner.tsx': [],
  'components/ToastHost.tsx': [],
  'components/PushOnboardingPrompt.tsx': [],
  'components/MoveSheet.tsx': [],
  'components/TagSheet.tsx': [],
  'components/TemplateSheet.tsx': [],
  'components/IdentitySheet.tsx': [],
  'components/QrScanModal.tsx': [],
  'components/email/ActionSheet.tsx': [],
  'components/email/AddressActionSheet.tsx': [],
  'components/email/CalendarInvitationBanner.tsx': [],
  'components/email/ListAttachmentChips.tsx': [],
  'components/email/ReadReceiptBanner.tsx': [],
  'components/email/UnsubscribeBanner.tsx': [],
  'screens/EmailThreadScreen.tsx': [],
  // Protocol names on the authentication chips.
  'components/email/MessageHeader.tsx': ['SPF', 'DKIM', 'DMARC'],
  'components/email/MessageContent.tsx': [],
  'components/email/ThreadMessageCard.tsx': [],
  'components/email/QuickReplyBox.tsx': [],
  'components/email/AttachmentChips.tsx': [],
  'components/email/AttachmentPreviewModal.tsx': [],
};

describe('translated screens', () => {
  for (const [file, allow] of Object.entries(TRANSLATED_FILES)) {
    it(`${file} has no hard-coded English text`, () => {
      expect(findUntranslatedLiterals(join(SRC, file), allow)).toEqual([]);
    });
  }
});
