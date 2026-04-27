import { create } from 'zustand';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

interface NetworkState {
  /** Best-effort online flag. True when we have an internet-reachable connection
   *  (or when NetInfo hasn't yet reported anything — assume online by default
   *  so we don't flash the offline banner during cold start). */
  online: boolean;
  /** Lower-level connection flag. True if a network interface is up, regardless
   *  of whether the internet is actually reachable. */
  connected: boolean;

  init: () => () => void;
}

function fromNetInfo(state: NetInfoState): { online: boolean; connected: boolean } {
  const connected = state.isConnected === true;
  // isInternetReachable is `null` until tested; treat null as "we don't know"
  // and fall back to connected.
  const online = state.isInternetReachable === false ? false : connected;
  return { online, connected };
}

export const useNetworkStore = create<NetworkState>((set) => ({
  online: true,
  connected: true,

  init: () => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      set(fromNetInfo(state));
    });
    void NetInfo.fetch().then((state) => set(fromNetInfo(state)));
    return unsubscribe;
  },
}));
