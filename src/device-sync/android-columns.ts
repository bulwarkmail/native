/**
 * Column names and constant values of Android's ContactsContract and
 * CalendarContract, as the providers spell them. The engine reads and writes
 * rows by these names through the native bridge (src/device-sync/native.ts),
 * so a typo here is a column the provider silently ignores or rejects.
 *
 * Only what device sync uses is listed. Pure constants: no React Native import.
 */

// ─── ContactsContract ──────────────────────────────────

export const RawContacts = {
  _ID: '_id',
  ACCOUNT_NAME: 'account_name',
  ACCOUNT_TYPE: 'account_type',
  SOURCE_ID: 'sourceid',
  VERSION: 'version',
  DIRTY: 'dirty',
  DELETED: 'deleted',
  SYNC1: 'sync1',
  SYNC2: 'sync2',
  SYNC3: 'sync3',
  SYNC4: 'sync4',
  RAW_CONTACT_IS_READ_ONLY: 'raw_contact_is_read_only',
  AGGREGATION_MODE: 'aggregation_mode',
  STARRED: 'starred',
  DISPLAY_NAME_PRIMARY: 'display_name',
} as const;

export const Data = {
  _ID: '_id',
  RAW_CONTACT_ID: 'raw_contact_id',
  MIMETYPE: 'mimetype',
  IS_PRIMARY: 'is_primary',
  IS_SUPER_PRIMARY: 'is_super_primary',
  IS_READ_ONLY: 'is_read_only',
  DATA_VERSION: 'data_version',
  DATA1: 'data1',
  DATA2: 'data2',
  DATA3: 'data3',
  DATA4: 'data4',
  DATA5: 'data5',
  DATA6: 'data6',
  DATA7: 'data7',
  DATA8: 'data8',
  DATA9: 'data9',
  DATA10: 'data10',
  DATA11: 'data11',
  DATA12: 'data12',
  DATA13: 'data13',
  DATA14: 'data14',
  DATA15: 'data15',
  DATA_SYNC1: 'data_sync1',
  DATA_SYNC2: 'data_sync2',
  DATA_SYNC3: 'data_sync3',
  DATA_SYNC4: 'data_sync4',
} as const;

/** `Data.MIMETYPE` values of the kinds device sync maps. */
export const MimeType = {
  STRUCTURED_NAME: 'vnd.android.cursor.item/name',
  NICKNAME: 'vnd.android.cursor.item/nickname',
  EMAIL: 'vnd.android.cursor.item/email_v2',
  PHONE: 'vnd.android.cursor.item/phone_v2',
  STRUCTURED_POSTAL: 'vnd.android.cursor.item/postal-address_v2',
  ORGANIZATION: 'vnd.android.cursor.item/organization',
  WEBSITE: 'vnd.android.cursor.item/website',
  EVENT: 'vnd.android.cursor.item/contact_event',
  RELATION: 'vnd.android.cursor.item/relation',
  NOTE: 'vnd.android.cursor.item/note',
  PHOTO: 'vnd.android.cursor.item/photo',
  GROUP_MEMBERSHIP: 'vnd.android.cursor.item/group_membership',
} as const;

export const StructuredName = {
  DISPLAY_NAME: 'data1',
  GIVEN_NAME: 'data2',
  FAMILY_NAME: 'data3',
  PREFIX: 'data4',
  MIDDLE_NAME: 'data5',
  SUFFIX: 'data6',
  PHONETIC_GIVEN_NAME: 'data7',
  PHONETIC_MIDDLE_NAME: 'data8',
  PHONETIC_FAMILY_NAME: 'data9',
  FULL_NAME_STYLE: 'data10',
  PHONETIC_NAME_STYLE: 'data11',
} as const;

/** Columns shared by the typed kinds (Email, Phone, Postal, …). */
export const CommonKind = {
  DATA: 'data1',
  TYPE: 'data2',
  LABEL: 'data3',
} as const;

export const Nickname = { NAME: 'data1', TYPE: 'data2', LABEL: 'data3' } as const;
export const NicknameType = { CUSTOM: 0, DEFAULT: 1, OTHER_NAME: 2, MAIDEN_NAME: 3, SHORT_NAME: 4, INITIALS: 5 } as const;

export const Email = { ADDRESS: 'data1', TYPE: 'data2', LABEL: 'data3', DISPLAY_NAME: 'data4' } as const;
export const EmailType = { CUSTOM: 0, HOME: 1, WORK: 2, OTHER: 3, MOBILE: 4 } as const;

export const Phone = { NUMBER: 'data1', TYPE: 'data2', LABEL: 'data3', NORMALIZED_NUMBER: 'data4' } as const;
export const PhoneType = {
  CUSTOM: 0,
  HOME: 1,
  MOBILE: 2,
  WORK: 3,
  FAX_WORK: 4,
  FAX_HOME: 5,
  PAGER: 6,
  OTHER: 7,
  CALLBACK: 8,
  CAR: 9,
  COMPANY_MAIN: 10,
  ISDN: 11,
  MAIN: 12,
  OTHER_FAX: 13,
  RADIO: 14,
  TELEX: 15,
  TTY_TDD: 16,
  WORK_MOBILE: 17,
  WORK_PAGER: 18,
  ASSISTANT: 19,
  MMS: 20,
} as const;

export const StructuredPostal = {
  FORMATTED_ADDRESS: 'data1',
  TYPE: 'data2',
  LABEL: 'data3',
  STREET: 'data4',
  POBOX: 'data5',
  NEIGHBORHOOD: 'data6',
  CITY: 'data7',
  REGION: 'data8',
  POSTCODE: 'data9',
  COUNTRY: 'data10',
} as const;
export const PostalType = { CUSTOM: 0, HOME: 1, WORK: 2, OTHER: 3 } as const;

export const Organization = {
  COMPANY: 'data1',
  TYPE: 'data2',
  LABEL: 'data3',
  TITLE: 'data4',
  DEPARTMENT: 'data5',
  JOB_DESCRIPTION: 'data6',
  SYMBOL: 'data7',
  PHONETIC_NAME: 'data8',
  OFFICE_LOCATION: 'data9',
} as const;
export const OrganizationType = { CUSTOM: 0, WORK: 1, OTHER: 2 } as const;

export const Website = { URL: 'data1', TYPE: 'data2', LABEL: 'data3' } as const;
export const WebsiteType = { CUSTOM: 0, HOMEPAGE: 1, BLOG: 2, PROFILE: 3, HOME: 4, WORK: 5, FTP: 6, OTHER: 7 } as const;

export const ContactEvent = { START_DATE: 'data1', TYPE: 'data2', LABEL: 'data3' } as const;
export const ContactEventType = { CUSTOM: 0, ANNIVERSARY: 1, OTHER: 2, BIRTHDAY: 3 } as const;

export const Relation = { NAME: 'data1', TYPE: 'data2', LABEL: 'data3' } as const;
export const RelationType = {
  CUSTOM: 0,
  ASSISTANT: 1,
  BROTHER: 2,
  CHILD: 3,
  DOMESTIC_PARTNER: 4,
  FATHER: 5,
  FRIEND: 6,
  MANAGER: 7,
  MOTHER: 8,
  PARENT: 9,
  PARTNER: 10,
  REFERRED_BY: 11,
  RELATIVE: 12,
  SISTER: 13,
  SPOUSE: 14,
} as const;

export const Note = { NOTE: 'data1' } as const;

export const Photo = { PHOTO_FILE_ID: 'data14', PHOTO: 'data15' } as const;

export const GroupMembership = { GROUP_ROW_ID: 'data1', GROUP_SOURCE_ID: 'group_sourceid' } as const;

export const Groups = {
  _ID: '_id',
  ACCOUNT_NAME: 'account_name',
  ACCOUNT_TYPE: 'account_type',
  SOURCE_ID: 'sourceid',
  VERSION: 'version',
  DIRTY: 'dirty',
  DELETED: 'deleted',
  TITLE: 'title',
  NOTES: 'notes',
  GROUP_VISIBLE: 'group_visible',
  SHOULD_SYNC: 'should_sync',
  GROUP_IS_READ_ONLY: 'group_is_read_only',
  SYNC1: 'sync1',
  SYNC2: 'sync2',
  SYNC3: 'sync3',
  SYNC4: 'sync4',
} as const;

export const ContactsSettings = {
  ACCOUNT_NAME: 'account_name',
  ACCOUNT_TYPE: 'account_type',
  UNGROUPED_VISIBLE: 'ungrouped_visible',
  SHOULD_SYNC: 'should_sync',
} as const;

// ─── CalendarContract ──────────────────────────────────

export const Calendars = {
  _ID: '_id',
  ACCOUNT_NAME: 'account_name',
  ACCOUNT_TYPE: 'account_type',
  _SYNC_ID: '_sync_id',
  DIRTY: 'dirty',
  NAME: 'name',
  CALENDAR_DISPLAY_NAME: 'calendar_displayName',
  CALENDAR_COLOR: 'calendar_color',
  CALENDAR_COLOR_KEY: 'calendar_color_index',
  CALENDAR_ACCESS_LEVEL: 'calendar_access_level',
  OWNER_ACCOUNT: 'ownerAccount',
  VISIBLE: 'visible',
  SYNC_EVENTS: 'sync_events',
  CALENDAR_TIME_ZONE: 'calendar_timezone',
  ALLOWED_REMINDERS: 'allowedReminders',
  ALLOWED_AVAILABILITY: 'allowedAvailability',
  ALLOWED_ATTENDEE_TYPES: 'allowedAttendeeTypes',
  MAX_REMINDERS: 'maxReminders',
  CAN_ORGANIZER_RESPOND: 'canOrganizerRespond',
  CAN_MODIFY_TIME_ZONE: 'canModifyTimeZone',
  /** Must stay 0: with 1 the provider keeps a LAST_SYNCED copy of every event an app edits. */
  CAN_PARTIALLY_UPDATE: 'canPartiallyUpdate',
  IS_PRIMARY: 'isPrimary',
  CAL_SYNC1: 'cal_sync1',
  CAL_SYNC2: 'cal_sync2',
  CAL_SYNC3: 'cal_sync3',
} as const;

/** `Calendars.CALENDAR_ACCESS_LEVEL` values. */
export const CalendarAccess = {
  NONE: 0,
  FREEBUSY: 100,
  READ: 200,
  RESPOND: 300,
  OVERRIDE: 400,
  CONTRIBUTOR: 500,
  EDITOR: 600,
  OWNER: 700,
  ROOT: 800,
} as const;

export const Events = {
  _ID: '_id',
  CALENDAR_ID: 'calendar_id',
  ACCOUNT_NAME: 'account_name',
  ACCOUNT_TYPE: 'account_type',
  _SYNC_ID: '_sync_id',
  DIRTY: 'dirty',
  DELETED: 'deleted',
  MUTATORS: 'mutators',
  SYNC_DATA1: 'sync_data1',
  SYNC_DATA2: 'sync_data2',
  SYNC_DATA3: 'sync_data3',
  SYNC_DATA4: 'sync_data4',
  SYNC_DATA5: 'sync_data5',
  SYNC_DATA6: 'sync_data6',
  UID_2445: 'uid2445',
  TITLE: 'title',
  DESCRIPTION: 'description',
  EVENT_LOCATION: 'eventLocation',
  STATUS: 'eventStatus',
  AVAILABILITY: 'availability',
  ACCESS_LEVEL: 'accessLevel',
  EVENT_COLOR: 'eventColor',
  EVENT_COLOR_KEY: 'eventColor_index',
  ORGANIZER: 'organizer',
  IS_ORGANIZER: 'isOrganizer',
  SELF_ATTENDEE_STATUS: 'selfAttendeeStatus',
  HAS_ALARM: 'hasAlarm',
  HAS_ATTENDEE_DATA: 'hasAttendeeData',
  GUESTS_CAN_MODIFY: 'guestsCanModify',
  GUESTS_CAN_INVITE_OTHERS: 'guestsCanInviteOthers',
  GUESTS_CAN_SEE_GUESTS: 'guestsCanSeeGuests',
  DTSTART: 'dtstart',
  DTEND: 'dtend',
  DURATION: 'duration',
  EVENT_TIMEZONE: 'eventTimezone',
  EVENT_END_TIMEZONE: 'eventEndTimezone',
  ALL_DAY: 'allDay',
  RRULE: 'rrule',
  RDATE: 'rdate',
  EXRULE: 'exrule',
  EXDATE: 'exdate',
  LAST_DATE: 'lastDate',
  ORIGINAL_ID: 'original_id',
  ORIGINAL_SYNC_ID: 'original_sync_id',
  ORIGINAL_INSTANCE_TIME: 'originalInstanceTime',
  ORIGINAL_ALL_DAY: 'originalAllDay',
  CUSTOM_APP_PACKAGE: 'customAppPackage',
  CUSTOM_APP_URI: 'customAppUri',
} as const;

export const EventStatus = { TENTATIVE: 0, CONFIRMED: 1, CANCELED: 2 } as const;
export const EventAvailability = { BUSY: 0, FREE: 1, TENTATIVE: 2 } as const;
export const EventAccess = { DEFAULT: 0, CONFIDENTIAL: 1, PRIVATE: 2, PUBLIC: 3 } as const;

export const Attendees = {
  _ID: '_id',
  EVENT_ID: 'event_id',
  ATTENDEE_NAME: 'attendeeName',
  ATTENDEE_EMAIL: 'attendeeEmail',
  ATTENDEE_RELATIONSHIP: 'attendeeRelationship',
  ATTENDEE_TYPE: 'attendeeType',
  ATTENDEE_STATUS: 'attendeeStatus',
} as const;
export const AttendeeRelationship = { NONE: 0, ATTENDEE: 1, ORGANIZER: 2, PERFORMER: 3, SPEAKER: 4 } as const;
export const AttendeeType = { NONE: 0, REQUIRED: 1, OPTIONAL: 2, RESOURCE: 3 } as const;
export const AttendeeStatus = { NONE: 0, ACCEPTED: 1, DECLINED: 2, INVITED: 3, TENTATIVE: 4 } as const;

export const Reminders = {
  _ID: '_id',
  EVENT_ID: 'event_id',
  MINUTES: 'minutes',
  METHOD: 'method',
} as const;
export const ReminderMethod = { DEFAULT: 0, ALERT: 1, EMAIL: 2, SMS: 3, ALARM: 4 } as const;

export const ExtendedProperties = {
  _ID: '_id',
  EVENT_ID: 'event_id',
  NAME: 'name',
  VALUE: 'value',
} as const;

export const Colors = {
  _ID: '_id',
  ACCOUNT_NAME: 'account_name',
  ACCOUNT_TYPE: 'account_type',
  COLOR_TYPE: 'color_type',
  COLOR_KEY: 'color_index',
  COLOR: 'color',
} as const;
export const ColorType = { CALENDAR: 0, EVENT: 1 } as const;
