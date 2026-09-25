import type { JMAPSession } from '../api/types';
import { sessionFingerprint } from './server-fingerprint';

/** The signed-in account and the server the Files drive on screen was read from. */
export interface DriveScope {
  /** Local account id (username@host). */
  account: string | null;
  /** Fingerprint of the session it was read with (lib/server-fingerprint); null without one. */
  server: string | null;
}

export type DriveAction =
  /** First read, when the screen mounts. */
  | 'load'
  /** Start over: the nodes, the folder stack and the selection are another drive's. */
  | 'reset'
  /** Read again in place: a new session of the same server. */
  | 'reload'
  /** Leave it: the session was lost, there is nothing to read with. */
  | 'keep';

/**
 * What a change of the signed-in account or of its session means for the
 * drive on screen. The local account id leaves the port out, and a server
 * reinstalled at the same address (Stalwart 1.0 has no migration from 0.16)
 * keeps it too; there the node ids name other files, and acting on the rows
 * on screen would reach them. The session fingerprint tells those servers
 * apart. Resolves to the action and the scope the drive then belongs to.
 */
export function driveChange(
  loaded: DriveScope | undefined,
  account: string | null,
  session: JMAPSession | null,
): { action: DriveAction; scope: DriveScope } {
  const server = session ? sessionFingerprint(session) : null;
  if (!loaded) return { action: 'load', scope: { account, server } };
  if (loaded.account !== account) return { action: 'reset', scope: { account, server } };
  if (!server) return { action: 'keep', scope: loaded };
  if (loaded.server && loaded.server !== server) return { action: 'reset', scope: { account, server } };
  return { action: 'reload', scope: { account, server } };
}
