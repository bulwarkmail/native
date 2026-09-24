import type { Attachment, EmailAddress } from '../api/types';

/** The message a reply / forward / draft edit starts from. */
export interface ComposeReplyContext {
  from: EmailAddress;
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  /** Original `Reply-To` header - wins over `from` for a reply (RFC 5322). */
  replyToAddresses?: EmailAddress[];
  subject: string;
  /** Plain-text body used for the quote when no HTML body exists. */
  body?: string;
  /** Sanitised HTML body for a layout-preserving quote. */
  htmlBody?: string;
  receivedAt?: string;
  sentAt?: string;
  /**
   * RFC 5322 threading, bare msg-ids. `messageId` is the original's
   * Message-ID; the composer derives In-Reply-To/References from it and the
   * original's `references`. (The JMAP object id is never a valid msg-id.)
   */
  messageId?: string[] | null;
  references?: string[] | null;
  /** @deprecated legacy string form; prefer `messageId`/`references`. */
  inReplyTo?: string;
  /** Original attachments to carry along on a forward (blob refs). */
  attachments?: Attachment[];
  /** JMAP id of the original message, for `$answered` / `$forwarded`. */
  originalEmailId?: string;
  /** Owning JMAP account when the original lives in a shared/group account. */
  jmapAccountId?: string;
}

/** An existing server draft being re-opened for editing. */
export interface ComposeDraftContext {
  id: string;
  jmapAccountId?: string;
  from?: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject?: string;
  htmlBody?: string;
  textBody?: string;
  attachments?: Attachment[];
  messageId?: string[] | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
}

export type RootStackParamList = {
  MainTabs: undefined;
  EmailThread: {
    emailId: string;
    threadId: string;
    subject?: string;
    /**
     * JMAP account the message lives in; unset for the user's own mail. The
     * opener names it: the viewer never derives it from the open folder,
     * whose account may hold another message under the same id.
     */
    jmapAccountId?: string;
    /**
     * Ids to page over when the message was opened from a list other than
     * the active folder (unified inbox, contact activity). When absent the
     * viewer pages over the store's current folder.
     */
    emailIds?: string[];
  };
  EmailSource: { emailId: string; blobId: string; subject?: string; jmapAccountId?: string };
  Compose:
    | {
        mode?: 'reply' | 'replyAll' | 'forward';
        replyTo?: ComposeReplyContext;
        draft?: ComposeDraftContext;
        prefillTo?: EmailAddress[];
        prefillCc?: EmailAddress[];
        prefillBcc?: EmailAddress[];
        prefillSubject?: string;
        prefillBody?: string;
        /** Files shared into the app (content:// or file:// URIs). */
        prefillAttachments?: Array<{ uri: string; name: string; type: string; size?: number }>;
      }
    | undefined;
  ContactDetail: { contactId: string };
  ContactForm: {
    contactId?: string;
    addressBookId?: string;
    asGroup?: boolean;
    prefill?: { email: string; name?: string };
    /** Pre-selected member ids when creating a group. */
    memberIds?: string[];
  };
  GroupDetail: { groupId: string };
  AddAccount: undefined;
  Scheduled: undefined;
  UnifiedInbox:
    | {
        /** Per-role unified view ("All Sent", …); defaults to the inbox. */
        role?: 'inbox' | 'sent' | 'drafts' | 'junk' | 'archive' | 'trash';
        /** Cross-folder views: every included folder, unread only, starred only. */
        view?: 'all' | 'unread' | 'starred';
      }
    | undefined;
};

export type MainTabsParamList = {
  Mail: undefined;
  Calendar: undefined;
  Contacts: undefined;
  Files: undefined;
  Settings: undefined;
};
