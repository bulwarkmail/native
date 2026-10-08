import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native';
import { openExternalUrl } from '../../lib/open-url';
import {
  CalendarPlus, Check, HelpCircle, X, MapPin, Video, Clock, CalendarDays, AlertTriangle,
  ShieldCheck, ShieldAlert, ChevronDown, ChevronUp,
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { format, parseISO } from 'date-fns';
import type { Calendar, Email, CalendarEvent } from '../../api/types';
import type { RootStackParamList } from '../../navigation/types';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { fetchCalendarBlobText, findEventsByUid, parseCalendarBlob, updateEvent } from '../../api/calendar';
import { useCalendarStore } from '../../stores/calendar-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore, type TranslateFn } from '../../stores/locale-store';
import {
  calendarInvitationKey,
  findCalendarAttachment,
  findParticipantByEmail,
  formatInvitationActor,
  getInvitationActorSummary,
  getInvitationMethod,
  getInvitationTrustAssessment,
  getOrganizerEmail,
  getOrganizerName,
  invitationSentFrom,
  invitationBannerDetails,
  isUserOrganizer,
  buildReplyTo,
  isSameInvitationEvent,
  mayImportOver,
  reviewCounterProposal,
  proposalStillMatches,
  withFetchedDescriptionType,
  type CounterProposalReview,
  type InvitationChangeItem,
  type ProposalHold,
  type InvitationMethod,
  type InvitationTrustAssessment,
} from '../../lib/calendar-invitation';
import { addressesForAccount, useUserCalendarAddresses } from '../../lib/calendar-user-addresses';
import { canCreateEventsIn } from '../../lib/calendar-editability';
import { getCalendarColor, getEventStartDate, timePattern } from '../../lib/calendar-utils';
import { getDateFnsLocale } from '../../lib/calendar-locale';
import { AccountNotServedError, requireShownAccountScope, useEmailStore } from '../../stores/email-store';
import { useAccountStore } from '../../stores/account-store';
import { toDisplayDate } from '../../lib/calendar-timezone';
import { isServerRecurrenceInstance } from '../../lib/recurrence-instances';
import { invitationViewTarget } from '../../lib/invitation-view-target';
import { setPendingCalendarView } from '../../navigation/pending-calendar-open';
import { plainDisplayText } from '../../lib/display-text';
import { importAndRespond, importInvitation, InvitationUidConflictError } from '../../lib/invitation-actions';
import type { OpScope } from '../../api/op-scope';
import { useAccountSubscriptions } from '../../stores/calendar-subscriptions-store';

type BannerState = 'loading' | 'parsed' | 'done' | 'error';
type RsvpStatus = 'accepted' | 'tentative' | 'declined';

interface Props {
  email: Email;
  // Account the email lives in (a shared mailbox's owner); the .ics blob is
  // parsed against it. Undefined for the user's own mailboxes.
  jmapAccountId?: string;
  // The app account the message is shown in. Every lookup and write goes out
  // only while it is shown and served; missing, they are refused.
  appAccountId?: string;
}

// Literal t() calls so the keys are harvested into the catalog.
function trustReasonText(
  trust: InvitationTrustAssessment,
  t: (key: string, fallback?: string) => string,
): string | null {
  // An attendee's answer is checked against the attendee, not the organizer.
  const attendee = trust.expectedSender === 'attendee';
  switch (trust.reason) {
    case null:
      return null;
    case 'sender_mismatch_unverified':
      return attendee
        ? t(
          'calendar.invitation.trust_attendee_mismatch_unverified',
          'The sender does not match the attendee who answered and the message is not authenticated.',
        )
        : t(
          'calendar.invitation.trust_sender_mismatch_unverified',
          'The sender does not match the organizer and the message is not authenticated.',
        );
    case 'authentication_failed':
      return t('calendar.invitation.trust_authentication_failed', 'This message failed sender authentication (SPF/DKIM/DMARC).');
    case 'sender_mismatch':
      return attendee
        ? t('calendar.invitation.trust_attendee_mismatch', 'The sender differs from the attendee who answered.')
        : t('calendar.invitation.trust_sender_mismatch', 'The sender differs from the event organizer.');
    case 'authentication_missing':
      return t('calendar.invitation.trust_authentication_missing', 'The sender could not be verified.');
    case 'responder_not_on_event':
      return t(
        'calendar.invitation.trust_responder_not_on_event',
        'This answers an event you don\'t organize, or comes from someone who isn\'t on it.',
      );
  }
}

function participationLabel(
  status: string | null,
  t: (key: string, fallback?: string) => string,
): string | null {
  switch (status) {
    case 'accepted': return t('email_viewer.calendar_invitation.response_accepted', 'Accepted');
    case 'tentative': return t('email_viewer.calendar_invitation.response_tentative', 'Tentative');
    case 'declined': return t('email_viewer.calendar_invitation.response_declined', 'Declined');
    case 'delegated': return t('email_viewer.calendar_invitation.response_delegated', 'Delegated');
    case 'needs-action': return t('email_viewer.calendar_invitation.response_needed', 'Needs response');
    default: return null;
  }
}

function changeLabel(label: InvitationChangeItem['label'], t: TranslateFn): string {
  switch (label) {
    case 'title': return t('email_viewer.calendar_invitation.change_title', 'Title');
    case 'time': return t('email_viewer.calendar_invitation.change_time', 'Time');
    case 'location': return t('email_viewer.calendar_invitation.change_location', 'Location');
    case 'virtual_location': return t('email_viewer.calendar_invitation.change_virtual_location', 'Meeting link');
    case 'description': return t('email_viewer.calendar_invitation.change_description', 'Description');
  }
}

// Why Apply is withheld, said rather than leaving the button out.
function proposalHoldText(hold: ProposalHold, t: TranslateFn): string {
  switch (hold) {
    case 'recurring':
      return t('calendar.invitation.proposal_recurring', 'This proposal is for a repeating event. Change it in the calendar.');
    case 'proposer_unknown':
    case 'proposer_not_attendee':
      return t('calendar.invitation.proposal_not_attendee', 'This proposal does not come from an attendee of your event, so it can\'t be applied here.');
    case 'sender_not_proposer':
      return t('calendar.invitation.proposal_sender_mismatch', 'This message was not sent by the attendee who proposed the changes, so they can\'t be applied here.');
    case 'sender_unverified':
      return t('calendar.invitation.proposal_unverified', 'The sender of this proposal could not be verified, so it can\'t be applied here.');
    case 'unsupported':
      return t('calendar.invitation.proposal_unsupported', 'Part of this proposal can\'t be applied as written. Change the event in the calendar.');
  }
}

// Asked for besides the usual properties: whether the stored description is
// plain text decides whether a proposed one may be written into it.
const REVIEW_PROPERTIES = ['descriptionContentType'] as const;

// The stored event a counter proposal is reviewed against, as the server
// holds it: an expanded occurrence (what the calendar loads) carries a
// synthetic id and drops the all-day flag and recurrence.
// Every caller fetched with REVIEW_PROPERTIES, so an absent
// descriptionContentType there means plain text (withFetchedDescriptionType).
function storedEventOf(found: CalendarEvent[]): CalendarEvent | null {
  const stored = found.find((e) => !isServerRecurrenceInstance(e));
  return stored ? withFetchedDescriptionType(stored) : null;
}

// Who the message comes from and what they did, by iTIP method.
function actorText(
  method: InvitationMethod,
  name: string,
  status: string | null,
  t: TranslateFn,
): string | null {
  switch (method) {
    case 'reply':
      return status
        ? t('email_viewer.calendar_invitation.actor_response_info', '{name} responded {status}.', { name, status })
        : t('email_viewer.calendar_invitation.actor_sent_info', 'Sent by {name}.', { name });
    case 'counter':
      return t('email_viewer.calendar_invitation.actor_counter_info', '{name} proposed changes to this event.', { name });
    case 'refresh':
      return t('email_viewer.calendar_invitation.actor_refresh_info', '{name} asked for the latest event details.', { name });
    case 'declinecounter':
      return t('email_viewer.calendar_invitation.actor_declined_counter_info', '{name} declined the counter proposal.', { name });
    case 'request':
    case 'publish':
    case 'add':
    case 'cancel':
      return t('email_viewer.calendar_invitation.actor_sent_info', 'Sent by {name}.', { name });
    default:
      return null;
  }
}

export function CalendarInvitationBanner({ email, jmapAccountId, appAccountId }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const shownAppAccountId = useEmailStore((s) => s.activeAccountId);
  const signedInAppAccountId = useAccountStore((s) => s.activeAccountId);
  const dateLocale = getDateFnsLocale(useLocaleStore((s) => s.locale));
  const enabled = useSettingsStore((s) => s.calendarInvitationParsingEnabled);
  const timeFormat = useSettingsStore((s) => s.calendarTimeFormat);
  // Read by getEventStartDate; subscribed so a new zone redraws the time.
  useSettingsStore((s) => s.calendarTimeZone);
  const calendars = useCalendarStore((s) => s.calendars);
  const storeEvents = useCalendarStore((s) => s.events);
  const subscriptions = useAccountSubscriptions();
  const importEvents = useCalendarStore((s) => s.importEvents);
  const rsvpEvent = useCalendarStore((s) => s.rsvpEvent);
  // No live fallback: without the account the message was shown in, a write
  // is refused by the store rather than sent for whichever account is shown.
  const ownerAppAccountId = appAccountId;
  const attachment = React.useMemo(() => findCalendarAttachment(email), [email]);
  // Login address + identities + aliases, so invitations addressed to an
  // alias still show the RSVP buttons. Only an invitation looks the aliases up.
  const currentUserEmails = useUserCalendarAddresses(!!attachment && enabled);
  // The invitation is loaded once per message, account and calendar part;
  // a mark-read or star hands a new `email` for the same one.
  const invitationKey = calendarInvitationKey(email, attachment, jmapAccountId);
  const latest = React.useRef({ email, attachment });
  // The invitation shown now, for work that lands after a tap.
  const currentInvitationKey = React.useRef(invitationKey);
  currentInvitationKey.current = invitationKey;
  latest.current = { email, attachment };

  const [state, setState] = React.useState<BannerState>('loading');
  const [event, setEvent] = React.useState<Partial<CalendarEvent> | null>(null);
  // The invitation's event as found on the server by UID, for one outside
  // the calendar's loaded window.
  const [serverMatch, setServerMatch] = React.useState<CalendarEvent | null>(null);
  const [method, setMethod] = React.useState<InvitationMethod>('unknown');
  const [rsvpStatus, setRsvpStatus] = React.useState<RsvpStatus | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [calendarId, setCalendarId] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  // Per message, not remembered: another invitation opens expanded.
  const [collapsed, setCollapsed] = React.useState(false);
  // For a counter: the stored event in the message's account, found by UID.
  const [storedEvent, setStoredEvent] = React.useState<CalendarEvent | null>(null);
  // Set synchronously, so a second tap can't send the proposal twice.
  const applying = React.useRef(false);
  // The review the organizer confirmed: only that is sent.
  const confirmedReview = React.useRef<Pick<CounterProposalReview, 'changes' | 'patch'> | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const { email: current, attachment: part } = latest.current;
    if (!invitationKey || !part || !enabled) return;
    setState('loading');
    setServerMatch(null);
    setStoredEvent(null);
    setCollapsed(false);
    // The look-up goes out on the connection serving the message's account
    // when the banner loaded, or not at all.
    let lookupScope: OpScope | null = null;
    try {
      lookupScope = requireShownAccountScope(ownerAppAccountId);
    } catch {
      lookupScope = null;
    }
    (async () => {
      try {
        const events = await parseCalendarBlob(part.blobId, jmapAccountId);
        if (cancelled) return;
        if (events.length === 0) {
          setState('error');
          return;
        }
        const parsed = events[0];
        setEvent(parsed);
        // The store only holds the calendar's loaded window; look the event
        // up on the server so one already there counts as existing and the
        // RSVP goes to it. Best-effort, must not block the banner.
        if (lookupScope && parsed.uid && !useCalendarStore.getState().events.some((e) => e.uid === parsed.uid)) {
          findEventsByUid(parsed.uid, lookupScope)
            .then((found) => { if (!cancelled && found[0]) setServerMatch(found[0]); })
            .catch(() => undefined);
        }
        // Explicit method (Content-Type params) first; JMAP usually strips
        // them, so fall back to the raw ICS METHOD line before guessing.
        let detected = getInvitationMethod(parsed, { email: current, attachment: part });
        if (detected === 'unknown') {
          const raw = await fetchCalendarBlobText(part.blobId, jmapAccountId);
          if (cancelled) return;
          detected = getInvitationMethod(parsed, { email: current, attachment: part, rawIcs: raw });
        }
        setMethod(detected);
        setState('parsed');
        // A counter is reviewed against the event as stored, on the message's
        // account; never against another account's event with that UID.
        if (detected === 'counter' && lookupScope && parsed.uid) {
          findEventsByUid(parsed.uid, lookupScope, { extraProperties: REVIEW_PROPERTIES })
            .then((found) => { if (!cancelled) setStoredEvent(storedEventOf(found)); })
            .catch(() => undefined);
        }
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [invitationKey, enabled, jmapAccountId, ownerAppAccountId]);

  // Import into the account's default calendar; never into a shared calendar,
  // an iCal subscription (the next feed sync would delete the event) or a
  // read-only one. The user can still pick another writable calendar.
  const candidates = React.useMemo(() => {
    const isSubscriptionCalendar = (id: string) => subscriptions.some((s) => s.calendarId === id);
    return calendars.filter((cal) => !cal.isShared && canCreateEventsIn(cal, isSubscriptionCalendar));
  }, [calendars, subscriptions]);
  const targetCalendar: Calendar | undefined =
    candidates.find((cal) => cal.id === calendarId)
    ?? candidates.find((cal) => cal.isDefault)
    ?? candidates[0];

  // Already imported? Look for the UID among the loaded events, then among
  // what the server lookup found. Only an event with the invitation's
  // organizer counts: anyone can write an invitation with the UID of an
  // unrelated event of the user's, which it must not answer or link. An
  // event without an organizer on either side may still be imported over
  // (deduped), but is never "existing" for an answer.
  const { existing, uidConflict } = React.useMemo(() => {
    if (!event?.uid) return { existing: null, uidConflict: false };
    const sameUid = [...storeEvents.filter((e) => e.uid === event.uid), ...(serverMatch ? [serverMatch] : [])];
    const match = sameUid.find((e) => isSameInvitationEvent(e, event)) ?? null;
    return { existing: match, uidConflict: sameUid.some((e) => !mayImportOver(e, event)) };
  }, [storeEvents, event, serverMatch]);

  // The user's addresses count only for the account the message is shown in.
  const ownAddresses = addressesForAccount(
    ownerAppAccountId,
    { shown: shownAppAccountId, signedIn: signedInAppAccountId },
    currentUserEmails,
  );
  // An attendee's answer is trusted only as far as the stored event (the
  // user's, with that attendee) backs who sent it.
  const trustStored = method === 'counter' ? (storedEvent ?? existing) : existing;
  const trust = React.useMemo(
    () => (event
      ? getInvitationTrustAssessment(event, email, method, { stored: trustStored, userAddresses: ownAddresses })
      : null),
    [event, email, method, trustStored, ownAddresses],
  );

  if (!attachment || !enabled || state === 'error') return null;

  if (state === 'loading') {
    return (
      <View style={styles.banner}>
        <ActivityIndicator size="small" color={c.primary} />
        <Text style={styles.loadingText}>{t('calendar.invitation.reading', 'Reading invitation…')}</Text>
      </View>
    );
  }
  if (!event) return null;

  // Title, time, place and organizer of the event as the user's calendar
  // holds it, once it is there: the message's are its sender's to write.
  const { source: shownEvent, location, videoUri } = invitationBannerDetails(existing, event, method);
  // In the app's time zone, as the calendar shows it.
  const startDate = shownEvent.start || shownEvent.utcStart
    ? getEventStartDate({
      start: shownEvent.start ?? '',
      utcStart: shownEvent.utcStart,
      showWithoutTime: shownEvent.showWithoutTime,
      timeZone: shownEvent.timeZone,
    })
    : null;
  const dateLabel = startDate && !isNaN(startDate.getTime())
    ? (shownEvent.showWithoutTime
        ? format(startDate, 'EEEE, MMM d, yyyy', { locale: dateLocale })
        : format(startDate, `EEE, MMM d · ${timePattern(timeFormat)}`, { locale: dateLocale }))
    : null;
  // The organizer's address shows beside its name, as the trust row checked it.
  const shownTitle = plainDisplayText(shownEvent.title, 200) || t('calendar.invitation.title', 'Calendar invitation');
  const organizer = formatInvitationActor({ name: getOrganizerName(shownEvent), email: getOrganizerEmail(shownEvent) });
  const me = findParticipantByEmail(existing ?? event, currentUserEmails);
  // A REPLY, COUNTER or REFRESH goes from an attendee to the organizer: the
  // organizer doesn't answer or import it.
  const attendeeMessage = method === 'reply' || method === 'counter' || method === 'refresh';
  // Without an organizer and not in the calendar there is no one to answer
  // and nothing it could be answered on.
  const canRsvp = method !== 'cancel' && !attendeeMessage && !!me && (!!existing || !!getOrganizerEmail(event));
  const myExistingStatus = existing && me ? existing.participants?.[me.id]?.participationStatus : undefined;
  const currentStatus: RsvpStatus | null =
    rsvpStatus
    ?? (myExistingStatus === 'accepted' || myExistingStatus === 'tentative' || myExistingStatus === 'declined'
      ? myExistingStatus
      : null);
  // Only the organizer reviews a counter proposal or a refresh request.
  const userIsOrganizer = isUserOrganizer(existing ?? event, ownAddresses);

  // Change times: an instant shown in the calendar's zone, a floating time
  // and an all-day date as they are.
  const formatChangeTime = (iso: string | null) => {
    if (!iso) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return format(parseISO(iso), 'EEE, MMM d', { locale: dateLocale });
    const date = /Z$/.test(iso) ? toDisplayDate(new Date(iso)) : parseISO(iso);
    if (isNaN(date.getTime())) return '';
    return format(date, `EEE, MMM d · ${timePattern(timeFormat)}`, { locale: dateLocale });
  };
  const review = reviewCounterProposal({
    method, proposed: event, stored: storedEvent, userAddresses: ownAddresses, email, formatDateTime: formatChangeTime,
  });
  const proposedChanges = review?.changes ?? [];
  const showApply = !!review?.canApply;
  const proposalHold = review?.hold ?? null;

  const actor = getInvitationActorSummary(event, method);
  const actorLine = actor
    ? actorText(
      method,
      formatInvitationActor(actor) ?? t('email_viewer.calendar_invitation.actor_unknown', 'Someone'),
      participationLabel(actor.participationStatus, t),
      t,
    )
    : null;
  // Someone else sent the message on the actor's behalf (or claims to be them).
  const sentFrom = actor ? invitationSentFrom(actor.email, trust?.senderEmail) : null;
  const sequence = typeof event.sequence === 'number' && event.sequence > 0
    ? (event.sequence > 99 ? '99+' : event.sequence)
    : null;
  const toggleCollapsed = () => setCollapsed((v) => !v);

  // The day the event is on now (a counter proposes another), else the
  // invitation's own start; only while the message's account is shown.
  const viewSource = existing ?? event;
  const viewStart = viewSource.start || viewSource.utcStart
    ? getEventStartDate({
      start: viewSource.start ?? '',
      utcStart: viewSource.utcStart,
      showWithoutTime: viewSource.showWithoutTime,
      timeZone: viewSource.timeZone,
    })
    : null;
  const viewTarget = invitationViewTarget(viewStart, ownerAppAccountId ?? null, shownAppAccountId);
  const viewLabel = method === 'counter' && userIsOrganizer
    ? t('email_viewer.calendar_invitation.review_proposal', 'Review proposal')
    : method === 'refresh' && userIsOrganizer
      ? t('email_viewer.calendar_invitation.review_request', 'Review request')
      : t('email_viewer.calendar_invitation.view_in_calendar', 'View in calendar');

  const handleViewInCalendar = () => {
    // Checked again on the tap: the account may have switched since render.
    const target = invitationViewTarget(viewStart, ownerAppAccountId ?? null, useEmailStore.getState().activeAccountId);
    if (!target) return;
    setPendingCalendarView(target);
    navigation.navigate('MainTabs', { screen: 'Calendar' } as never);
  };

  const applyProposal = async () => {
    const confirmed = confirmedReview.current;
    confirmedReview.current = null;
    if (applying.current || !confirmed || !storedEvent || !event.uid) return;
    applying.current = true;
    setBusy(true);
    setNotice(null);
    try {
      // The banner's account, on the connection serving it, taken now:
      // refused after a switch.
      const at = requireShownAccountScope(ownerAppAccountId);
      // Read the event again on that scope and review it again, with this
      // account's addresses: sent only when it is the event reviewed, every
      // check still passes, and the changes are the ones confirmed.
      const found = storedEventOf(await findEventsByUid(event.uid, at, { extraProperties: REVIEW_PROPERTIES }));
      const addresses = addressesForAccount(
        ownerAppAccountId,
        { shown: useEmailStore.getState().activeAccountId, signedIn: useAccountStore.getState().activeAccountId },
        currentUserEmails,
      );
      const fresh = found && found.id === storedEvent.id
        ? reviewCounterProposal({
          method, proposed: event, stored: found, userAddresses: addresses, email, formatDateTime: formatChangeTime,
        })
        : null;
      if (!found || !fresh?.patch || !proposalStillMatches(confirmed, fresh)) {
        throw new Error('proposal no longer applies');
      }
      // Sends the updated event to every attendee.
      await updateEvent(found.baseEventId ?? found.originalId ?? found.id, fresh.patch, true, at);
      setNotice(t('email_viewer.calendar_invitation.proposal_applied', 'Proposed changes applied.'));
      // Review what the server holds now: nothing left to apply.
      // Only while this banner still shows the same invitation.
      const appliedFor = invitationKey;
      setStoredEvent(null);
      findEventsByUid(event.uid, at, { extraProperties: REVIEW_PROPERTIES })
        .then((now) => { if (currentInvitationKey.current === appliedFor) setStoredEvent(storedEventOf(now)); })
        .catch(() => undefined);
      void useCalendarStore.getState().refresh().catch(() => undefined);
    } catch (err) {
      setNotice(err instanceof AccountNotServedError
        ? err.message
        : t('email_viewer.calendar_invitation.action_failed', 'Could not complete that calendar action.'));
    } finally {
      applying.current = false;
      setBusy(false);
    }
  };

  const confirmApplyProposal = () => {
    if (applying.current || busy || !review?.canApply) return;
    // What is on screen now is what the organizer confirms.
    const shown = { changes: review.changes, patch: review.patch };
    const proposer = review.proposer ? formatInvitationActor(review.proposer) : null;
    const message = t('email_viewer.calendar_invitation.apply_confirm_message', "Every attendee will be sent the updated event. This can't be undone.");
    Alert.alert(
      t('email_viewer.calendar_invitation.apply_confirm_title', 'Apply the proposed changes?'),
      proposer
        ? `${t('calendar.invitation.apply_confirm_proposer', 'Proposed by {name}.', { name: proposer })}\n\n${message}`
        : message,
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel', onPress: () => { confirmedReview.current = null; } },
        {
          text: t('email_viewer.calendar_invitation.apply_proposal', 'Apply proposed changes'),
          style: 'destructive',
          onPress: () => { confirmedReview.current = shown; void applyProposal(); },
        },
      ],
    );
  };

  const uidConflictText = t(
    'calendar.invitation.uid_conflict',
    'Another event in your calendar has this invitation\'s ID but a different organizer, so this invitation can\'t be answered or added.',
  );

  const ensureImportedAndRsvp = async (status: RsvpStatus) => {
    if (busy || !targetCalendar) return;
    setBusy(true);
    setNotice(null);
    try {
      // Import (deduped by UID) unless it is there, find it, answer: all on
      // one scope taken now. Throws when no response went out.
      await importAndRespond({
        event,
        existing,
        calendarId: targetCalendar.id,
        status,
        userEmails: currentUserEmails,
        replyTo: buildReplyTo(event),
        appAccountId: ownerAppAccountId,
        actions: { importEvents, findEventsByUid, rsvpEvent },
        onFound: setServerMatch,
      });
      setRsvpStatus(status);
      setNotice(t('calendar.invitation.response_sent', 'Response sent'));
      setState('done');
    } catch (err) {
      setNotice(err instanceof InvitationUidConflictError
        ? uidConflictText
        : t('calendar.invitation.response_error', 'Could not send your response'));
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (busy || !targetCalendar) return;
    setBusy(true);
    setNotice(null);
    try {
      const { imported } = await importInvitation(event, targetCalendar.id, ownerAppAccountId, { importEvents, findEventsByUid });
      setNotice(
        imported > 0
          ? t('calendar.invitation.added', 'Added to calendar')
          : t('calendar.invitation.already_in_calendar', 'Already in your calendar'),
      );
      setState('done');
    } catch (err) {
      setNotice(err instanceof InvitationUidConflictError
        ? uidConflictText
        : t('calendar.invitation.add_error', 'Could not add the event'));
    } finally {
      setBusy(false);
    }
  };

  const trustColor = trust?.level === 'warning' ? c.error : trust?.level === 'caution' ? c.warning : c.success;

  return (
    <View style={[styles.banner, trust?.level === 'warning' && styles.bannerWarning]}>
      {/* Collapsed, the whole title row expands it, as webmail's card does. */}
      <Pressable
        style={styles.headerRow}
        onPress={collapsed ? toggleCollapsed : undefined}
        disabled={!collapsed}
        accessible={collapsed}
        accessibilityRole={collapsed ? 'button' : undefined}
        accessibilityState={collapsed ? { expanded: false } : undefined}
        // The row hides its children from a screen reader while it is one
        // button, so the label names the event too.
        accessibilityLabel={collapsed ? `${shownTitle}, ${t('email_viewer.calendar_invitation.expand', 'Show details')}` : undefined}
      >
        <View style={styles.iconBadge}>
          <CalendarDays size={18} color={c.primary} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={2}>
            {shownTitle}
          </Text>
          {method === 'cancel' && (
            <Text style={styles.cancelled}>{t('calendar.invitation.cancelled', 'This event was cancelled')}</Text>
          )}
          {method === 'reply' && (
            <Text style={styles.subtitle}>{t('calendar.invitation.reply', 'A participant replied to this invitation')}</Text>
          )}
        </View>
        {sequence !== null && (
          <View style={styles.sequencePill}>
            <Text style={styles.sequenceText} numberOfLines={1}>
              {t('email_viewer.calendar_invitation.event_updated', 'Update #{sequence}', { sequence })}
            </Text>
          </View>
        )}
        <Pressable
          onPress={toggleCollapsed}
          hitSlop={13}
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={collapsed
            ? t('email_viewer.calendar_invitation.expand', 'Show details')
            : t('email_viewer.calendar_invitation.collapse', 'Hide details')}
        >
          {collapsed ? <ChevronDown size={18} color={c.textMuted} /> : <ChevronUp size={18} color={c.textMuted} />}
        </Pressable>
      </Pressable>

      {/* A warning stays in view while the rest is collapsed: the title above
          is the sender's to write and must not stand alone. */}
      {trust && (!collapsed || trust.level !== 'trusted') && (
        <View style={[styles.trustRow, { borderColor: trustColor }]}>
          {trust.level === 'trusted' ? (
            <ShieldCheck size={14} color={trustColor} />
          ) : (
            <ShieldAlert size={14} color={trustColor} />
          )}
          <Text style={[styles.trustText, { color: trustColor }]} numberOfLines={3}>
            {trustReasonText(trust, t) ?? t('calendar.invitation.trust_verified', 'Sender verified')}
          </Text>
        </View>
      )}

      {!collapsed && (
        <>
          {(actorLine || actor?.participationComment) && (
            <View style={styles.actorBlock}>
              {actorLine && (
                <Text style={styles.actorText}>
                  {sentFrom
                    ? `${actorLine} ${t('calendar.invitation.actor_sent_from', '(sent from {address})', { address: plainDisplayText(sentFrom, 254) })}`
                    : actorLine}
                </Text>
              )}
              {actor?.participationComment ? (
                <Text style={[styles.actorText, styles.actorNote]} numberOfLines={4}>
                  {/* The sender's own words, quoted and flattened to one run so they
                      can't pass for the banner's own lines (such as the trust row). */}
                  {t('email_viewer.calendar_invitation.actor_note', 'Note: {comment}', {
                    comment: `\u201c${plainDisplayText(actor.participationComment, 500)}\u201d`,
                  })}
                </Text>
              ) : null}
            </View>
          )}

          {dateLabel && (
            <Row icon={<Clock size={15} color={c.textMuted} />} text={dateLabel} styles={styles} />
          )}
          {location ? (
            <Row icon={<MapPin size={15} color={c.textMuted} />} text={location} styles={styles} />
          ) : null}
          {videoUri ? (
            <Pressable style={styles.detailRow} onPress={() => { void openExternalUrl(videoUri, { confirm: true }); }}>
              <Video size={15} color={c.textMuted} />
              <Text style={[styles.detailText, { color: c.primary }]} numberOfLines={1}>
                {t('calendar.invitation.join_video', 'Join video call')}
              </Text>
            </Pressable>
          ) : null}
          {organizer ? (
            <Row
              icon={<CalendarPlus size={15} color={c.textMuted} />}
              text={t('email_viewer.calendar_invitation.organizer', 'Organized by {name}', { name: organizer })}
              styles={styles}
            />
          ) : null}
          {viewTarget && (
            <Pressable style={styles.viewLink} onPress={handleViewInCalendar} accessibilityRole="button" hitSlop={4}>
              <CalendarDays size={15} color={c.primary} />
              <Text style={styles.viewLinkText}>{viewLabel}</Text>
            </Pressable>
          )}
          {proposedChanges.length > 0 && (
            <View style={styles.changeList}>
              <Text style={styles.changeHeading}>
                {t('email_viewer.calendar_invitation.proposed_changes', 'Proposed changes')}
              </Text>
              {/* Values another user wrote, already flattened; a meeting link
                  is shown as text, never opened from here. */}
              {proposedChanges.map((change) => (
                <Text key={change.label} style={styles.changeText}>
                  <Text style={styles.changeLabel}>{changeLabel(change.label, t)}: </Text>
                  {t('email_viewer.calendar_invitation.change_from_to', '{before} -> {after}', {
                    before: change.before ?? t('email_viewer.calendar_invitation.change_empty', 'None'),
                    after: change.after,
                  })}
                  {change.notApplied
                    ? ` ${t('calendar.invitation.change_not_applied', '(not applied: it can\'t be changed safely here)')}`
                    : null}
                </Text>
              ))}
            </View>
          )}
          {proposalHold && (
            <View style={styles.warnRow}>
              <AlertTriangle size={14} color={c.warning} />
              <Text style={styles.warnText}>{proposalHoldText(proposalHold, t)}</Text>
            </View>
          )}
          {showApply && (
            <Pressable
              style={[styles.applyBtn, busy && { opacity: 0.5 }]}
              onPress={confirmApplyProposal}
              disabled={busy}
              accessibilityRole="button"
            >
              {busy ? (
                <ActivityIndicator size="small" color={c.primaryForeground} />
              ) : (
                <Check size={16} color={c.primaryForeground} />
              )}
              <Text style={styles.importBtnText}>
                {t('email_viewer.calendar_invitation.apply_proposal', 'Apply proposed changes')}
              </Text>
            </Pressable>
          )}
          {uidConflict && state !== 'done' && (
            <View style={styles.warnRow}>
              <AlertTriangle size={14} color={c.warning} />
              <Text style={styles.warnText}>{uidConflictText}</Text>
            </View>
          )}
          {existing && state !== 'done' && (
            <Row
              icon={<Check size={15} color={c.success} />}
              text={t('calendar.invitation.already_in_calendar', 'Already in your calendar')}
              styles={styles}
            />
          )}

          {state !== 'done' && !existing && !uidConflict && !attendeeMessage && targetCalendar && candidates.length > 1 && (
            <View>
              <Pressable style={styles.calendarPicker} onPress={() => setPickerOpen((v) => !v)}>
                <View style={[styles.calendarSwatch, { backgroundColor: getCalendarColor(targetCalendar) }]} />
                <Text style={styles.calendarPickerText} numberOfLines={1}>{targetCalendar.name}</Text>
                <ChevronDown size={14} color={c.textMuted} />
              </Pressable>
              {pickerOpen && (
                <View style={styles.calendarList}>
                  {candidates.map((cal) => (
                    <Pressable
                      key={cal.id}
                      style={[styles.calendarRow, cal.id === targetCalendar.id && styles.calendarRowActive]}
                      onPress={() => { setCalendarId(cal.id); setPickerOpen(false); }}
                    >
                      <View style={[styles.calendarSwatch, { backgroundColor: getCalendarColor(cal) }]} />
                      <Text style={styles.calendarPickerText} numberOfLines={1}>{cal.name}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          )}

          {notice && <Text style={styles.notice}>{notice}</Text>}

          {state !== 'done' && !uidConflict && (
            <View style={styles.actions}>
              {canRsvp ? (
                <>
                  <RsvpBtn label={t('calendar.invitation.accept', 'Yes')} active={currentStatus === 'accepted'} activeColor={c.success}
                    icon={<Check size={15} color={currentStatus === 'accepted' ? c.textInverse : c.success} />}
                    disabled={busy} onPress={() => ensureImportedAndRsvp('accepted')} c={c} styles={styles} />
                  <RsvpBtn label={t('calendar.invitation.tentative', 'Maybe')} active={currentStatus === 'tentative'} activeColor={c.warning}
                    icon={<HelpCircle size={15} color={currentStatus === 'tentative' ? c.textInverse : c.warning} />}
                    disabled={busy} onPress={() => ensureImportedAndRsvp('tentative')} c={c} styles={styles} />
                  <RsvpBtn label={t('calendar.invitation.decline', 'No')} active={currentStatus === 'declined'} activeColor={c.error}
                    icon={<X size={15} color={currentStatus === 'declined' ? c.textInverse : c.error} />}
                    disabled={busy} onPress={() => ensureImportedAndRsvp('declined')} c={c} styles={styles} />
                </>
              ) : !existing && !attendeeMessage ? (
                <Pressable
                  style={[styles.importBtn, (busy || !targetCalendar) && { opacity: 0.5 }]}
                  onPress={() => { void handleImport(); }}
                  disabled={busy || !targetCalendar}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={c.primaryForeground} />
                  ) : (
                    <CalendarPlus size={16} color={c.primaryForeground} />
                  )}
                  <Text style={styles.importBtnText}>{t('calendar.invitation.add_to_calendar', 'Add to calendar')}</Text>
                </Pressable>
              ) : null}
            </View>
          )}

          {!targetCalendar && state !== 'done' && (
            <View style={styles.warnRow}>
              <AlertTriangle size={14} color={c.warning} />
              <Text style={styles.warnText}>{t('calendar.invitation.no_writable_calendar', 'No writable calendar available')}</Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

function Row({
  icon, text, styles,
}: {
  icon: React.ReactNode;
  text: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.detailRow}>
      {icon}
      <Text style={styles.detailText} numberOfLines={2}>{text}</Text>
    </View>
  );
}

function RsvpBtn({
  label, icon, active, activeColor, disabled, onPress, c, styles,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  activeColor: string;
  disabled?: boolean;
  onPress: () => void;
  c: ThemePalette;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.rsvpBtn,
        active && { backgroundColor: activeColor, borderColor: activeColor },
        disabled && { opacity: 0.5 },
      ]}
    >
      {icon}
      <Text style={[styles.rsvpBtnText, active && { color: c.textInverse }]}>{label}</Text>
    </Pressable>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    banner: {
      marginHorizontal: spacing.lg,
      marginBottom: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      gap: spacing.xs,
    },
    bannerWarning: { borderColor: c.errorBorder, backgroundColor: c.errorBg },
    loadingText: { ...typography.caption, color: c.textMuted },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs, minHeight: 44 },
    iconBadge: {
      width: 32, height: 32, borderRadius: radius.sm,
      backgroundColor: c.primaryBg, alignItems: 'center', justifyContent: 'center',
    },
    title: { ...typography.bodySemibold, color: c.text },
    subtitle: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    cancelled: { ...typography.caption, color: c.error, marginTop: 2 },
    sequencePill: {
      flexShrink: 1,
      maxWidth: '40%',
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.full,
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.border,
    },
    sequenceText: { ...typography.caption, color: c.textMuted },
    actorBlock: { gap: 2, marginBottom: spacing.xs },
    actorText: { ...typography.caption, color: c.textSecondary },
    actorNote: { fontStyle: 'italic' },
    viewLink: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 4, alignSelf: 'flex-start' },
    viewLinkText: { ...typography.captionMedium, color: c.primary },
    changeList: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      padding: spacing.sm,
      gap: 4,
      marginVertical: spacing.xs,
    },
    changeHeading: { ...typography.captionMedium, color: c.text },
    changeText: { ...typography.caption, color: c.textMuted },
    changeLabel: { ...typography.captionMedium, color: c.text },
    trustRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.sm,
      borderWidth: 1,
      marginBottom: spacing.xs,
    },
    trustText: { ...typography.caption, flex: 1 },
    detailRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 2 },
    detailText: { flex: 1, ...typography.caption, color: c.textSecondary },
    calendarPicker: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
      marginTop: spacing.xs,
    },
    calendarPickerText: { ...typography.caption, color: c.text, flex: 1 },
    calendarSwatch: { width: 10, height: 10, borderRadius: 5 },
    calendarList: {
      marginTop: 4,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.background,
      overflow: 'hidden',
    },
    calendarRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    calendarRowActive: { backgroundColor: c.primaryBg },
    notice: { ...typography.captionMedium, color: c.primary, marginTop: spacing.xs },
    actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
    rsvpBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    rsvpBtnText: { ...typography.caption, color: c.text },
    importBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
      backgroundColor: c.primary,
    },
    importBtnText: { ...typography.bodyMedium, color: c.primaryForeground },
    applyBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      minHeight: 44,
      borderRadius: radius.sm,
      backgroundColor: c.primary,
      marginVertical: spacing.xs,
    },
    warnRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
    warnText: { ...typography.caption, color: c.warning },
  });
}
