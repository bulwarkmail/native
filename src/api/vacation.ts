import { jmapClient } from './jmap-client';
import { CAPABILITIES, type JMAPAccountInfo } from './types';

export interface VacationResponse {
  id: string;
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string;
  textBody: string;
  htmlBody: string | null;
}

const VACATION_USING = [CAPABILITIES.CORE, CAPABILITIES.MAIL, CAPABILITIES.VACATION];

const DEFAULT: VacationResponse = {
  id: 'singleton',
  isEnabled: false,
  fromDate: null,
  toDate: null,
  subject: '',
  textBody: '',
  htmlBody: null,
};

// The calls take an optional accountId so a shared/group account's responder
// can be managed too (webmail: "Shared with me" in Account settings). The
// default is the user's own mail account.
export async function getVacationResponse(
  accountId: string = jmapClient.accountId,
): Promise<VacationResponse> {
  const res = await jmapClient.request(
    [['VacationResponse/get', { accountId, ids: ['singleton'] }, '0']],
    VACATION_USING,
  );
  const resp = res.methodResponses?.[0];
  if (resp && resp[0] === 'VacationResponse/get') {
    const list = (resp[1] as { list?: VacationResponse[] }).list ?? [];
    return list[0] ?? DEFAULT;
  }
  throw new Error('Unexpected response from VacationResponse/get');
}

export async function setVacationResponse(
  updates: Partial<Omit<VacationResponse, 'id'>>,
  accountId: string = jmapClient.accountId,
): Promise<void> {
  const res = await jmapClient.request(
    [['VacationResponse/set', {
      accountId,
      update: { singleton: updates },
    }, '0']],
    VACATION_USING,
  );
  const resp = res.methodResponses?.[0];
  if (resp && resp[0] === 'VacationResponse/set') {
    const result = resp[1] as { notUpdated?: Record<string, { description?: string }> };
    if (result.notUpdated?.singleton) {
      throw new Error(result.notUpdated.singleton.description ?? 'Failed to update vacation responder');
    }
    return;
  }
  throw new Error('Unexpected response from VacationResponse/set');
}

// Gate on the ACCOUNT capability: RFC 8621 advertises VacationResponse per
// account, so the session can list it while a given account lacks it.
// Stalwart doesn't always advertise capabilities on shared/group accounts, so
// treat non-personal accounts as capable, as the webmail does. A server that
// populates no accountCapabilities at all keeps the session-wide answer.
export function accountSupportsVacation(
  account: JMAPAccountInfo | undefined,
  sessionCapabilities: Record<string, unknown> | undefined,
): boolean {
  if (!sessionCapabilities || !(CAPABILITIES.VACATION in sessionCapabilities)) return false;
  if (!account) return false;
  if (!account.isPersonal || !account.accountCapabilities) return true;
  return CAPABILITIES.VACATION in account.accountCapabilities;
}

export function isVacationSupported(accountId?: string): boolean {
  const session = jmapClient.currentSession;
  if (!session) return false;
  return accountSupportsVacation(
    session.accounts?.[accountId ?? jmapClient.accountId],
    session.capabilities,
  );
}
