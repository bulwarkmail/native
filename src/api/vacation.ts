import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';

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

export async function getVacationResponse(): Promise<VacationResponse> {
  const accountId = jmapClient.accountId;
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
): Promise<void> {
  const accountId = jmapClient.accountId;
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

export function isVacationSupported(): boolean {
  const session = jmapClient.currentSession;
  if (!session) return false;
  const caps = session.capabilities ?? {};
  return CAPABILITIES.VACATION in caps;
}
