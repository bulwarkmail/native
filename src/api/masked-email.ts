// Masked addresses over the JMAP client (lib/masked-email has the calls and
// their checks). The webmail sends these through its server-side
// passthrough; the app holds its own credentials and asks Stalwart itself,
// as api/account-security does.

import { AuthenticationError, jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import { loginMovedFrom } from '../lib/compose-login';
import { servedLoginOf } from '../lib/draft-login';
import { MaskedEmailError, createMaskedEmailManager, type MaskedEmailManager } from '../lib/masked-email';

const STALWART_CAPABILITY = 'urn:stalwart:jmap';
const USING = [CAPABILITIES.CORE, STALWART_CAPABILITY];

/**
 * A manager for the login and account active now, or null when the account
 * does not list Stalwart's extension. It stops sending once another login
 * or account is active; ask for a new one then.
 */
export function maskedEmailManagerForActiveLogin(): MaskedEmailManager | null {
  const accountId = jmapClient.connectedAccountId;
  if (!accountId || !jmapClient.hasAccountCapability(STALWART_CAPABILITY, accountId)) return null;
  const owner = servedLoginOf(jmapClient);
  if (!owner) return null;
  return createMaskedEmailManager({
    accountId,
    maxObjectsInGet: jmapClient.getMaxObjectsInGet(),
    isCurrent: () => !loginMovedFrom(owner) && jmapClient.connectedAccountId === accountId,
    call: async (method, args) => {
      let response;
      try {
        response = await jmapClient.request([[method, args, 'masked']], USING);
      } catch (error) {
        if (error instanceof AuthenticationError) throw new MaskedEmailError('notAuthenticated', error.message);
        throw error;
      }
      const [name, result] = response.methodResponses?.[0] ?? [];
      if (name === 'error') {
        const { type, description } = (result ?? {}) as { type?: string; description?: string };
        throw new MaskedEmailError(type || 'serverFail', description);
      }
      if (name !== method) throw new MaskedEmailError('invalidResponse');
      return result as Record<string, unknown>;
    },
  });
}
