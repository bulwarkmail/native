import type { EmailAddress } from '../api/types';

export type RootStackParamList = {
  MainTabs: undefined;
  EmailThread: { emailId: string; threadId: string; subject?: string };
  Compose:
    | {
        mode?: 'reply' | 'replyAll' | 'forward';
        replyTo?: {
          from: EmailAddress;
          to?: EmailAddress[];
          cc?: EmailAddress[];
          subject: string;
          body?: string;
          inReplyTo?: string;
          references?: string;
        };
        prefillTo?: EmailAddress[];
      }
    | undefined;
  ContactDetail: { contactId: string };
  ContactForm: { contactId?: string; addressBookId?: string; asGroup?: boolean };
  GroupDetail: { groupId: string };
  AddAccount: undefined;
};

export type MainTabsParamList = {
  Mail: undefined;
  Calendar: undefined;
  Contacts: undefined;
  Files: undefined;
  Settings: undefined;
};
