import type { EmailAddress } from '../api/types';

export type RootStackParamList = {
  MainTabs: undefined;
  EmailThread: { emailId: string; threadId: string; subject?: string; jmapAccountId?: string };
  EmailSource: { emailId: string; blobId: string; subject?: string; jmapAccountId?: string };
  Compose:
    | {
        mode?: 'reply' | 'replyAll' | 'forward';
        replyTo?: {
          from: EmailAddress;
          to?: EmailAddress[];
          cc?: EmailAddress[];
          subject: string;
          body?: string;
          receivedAt?: string;
          inReplyTo?: string;
          references?: string;
        };
        prefillTo?: EmailAddress[];
        // Re-open an existing draft for editing. The composer loads the full
        // message, prefills its fields, and replaces the original on save/send.
        // Own-account drafts only: the composer can't write into a shared one.
        draft?: { emailId: string };
      }
    | undefined;
  ContactDetail: { contactId: string };
  ContactForm: { contactId?: string; addressBookId?: string; asGroup?: boolean };
  GroupDetail: { groupId: string };
  AddAccount: undefined;
  Scheduled: undefined;
  UnifiedInbox: undefined;
};

export type MainTabsParamList = {
  Mail: undefined;
  Calendar: undefined;
  Contacts: undefined;
  Files: undefined;
  Settings: undefined;
};
