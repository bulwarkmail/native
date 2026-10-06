import { create } from 'zustand';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { setServerReachabilitySink } from '../lib/server-reachability';

interface NetworkState {
  /** Best-effort online flag: a network interface is up, and either the
   *  internet probe has not failed or the mail server answered the last
   *  request. A mail server on the local network can answer while Android's
   *  probe (a Google URL) fails; that still counts as online. Assumed true
   *  before NetInfo reports, so the offline banner doesn't flash at cold start. */
  online: boolean;
  /** Lower-level connection flag. True if a network interface is up, regardless
   *  of whether the internet is actually reachable. */
  connected: boolean;
  /** NetInfo's internet probe: `null` until tested. */
  internetReachable: boolean | null;
  /** Whether the mail server answered the last request: `null` until one
   *  settles on this connection, `true` after any HTTP response (whatever its
   *  status), `false` after a transport failure. Reported by the transport
   *  through lib/server-reachability. */
  serverReachable: boolean | null;

  init: () => () => void;
  noteServerResponse: () => void;
  noteServerUnreachable: () => void;
}

function deriveOnline(connected: boolean, internetReachable: boolean | null, serverReachable: boolean | null): boolean {
  return connected && (internetReachable !== false || serverReachable === true);
}

export const useNetworkStore = create<NetworkState>((set, get) => {
  const fromNetInfo = (state: NetInfoState): void => {
    const prev = get();
    const connected = state.isConnected === true;
    // isInternetReachable is `null` until tested; treat null as "we don't know".
    const internetReachable = state.isInternetReachable ?? null;
    // A new connection says nothing about the server.
    const serverReachable = connected && !prev.connected ? null : prev.serverReachable;
    set({
      connected,
      internetReachable,
      serverReachable,
      online: deriveOnline(connected, internetReachable, serverReachable),
    });
  };

  const noteServer = (serverReachable: boolean): void => {
    const { connected, internetReachable } = get();
    const online = deriveOnline(connected, internetReachable, serverReachable);
    if (get().serverReachable === serverReachable && get().online === online) return;
    set({ serverReachable, online });
  };

  return {
    online: true,
    connected: true,
    internetReachable: null,
    serverReachable: null,

    init: () => {
      const unsubscribe = NetInfo.addEventListener(fromNetInfo);
      void NetInfo.fetch().then(fromNetInfo);
      return unsubscribe;
    },
    noteServerResponse: () => noteServer(true),
    noteServerUnreachable: () => noteServer(false),
  };
});

setServerReachabilitySink({
  response: () => useNetworkStore.getState().noteServerResponse(),
  unreachable: () => useNetworkStore.getState().noteServerUnreachable(),
});
