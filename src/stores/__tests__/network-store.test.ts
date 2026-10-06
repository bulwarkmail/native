import { describe, it, expect, beforeEach, vi } from 'vitest';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { useNetworkStore } from '../network-store';
import { reportServerResponse, reportServerUnreachable } from '../../lib/server-reachability';

// The device finding: the mail server is on the LAN and Android's internet
// probe (a Google URL) fails while the server answers. `online` must follow
// the server in that case, or Send queues and replay never runs.

type Listener = (state: NetInfoState) => void;
let listener: Listener | null = null;

function netInfo(isConnected: boolean | null, isInternetReachable: boolean | null): void {
  listener!({ isConnected, isInternetReachable } as NetInfoState);
}

beforeEach(() => {
  listener = null;
  vi.mocked(NetInfo.addEventListener).mockImplementation(((cb: Listener) => {
    listener = cb;
    return () => undefined;
  }) as unknown as typeof NetInfo.addEventListener);
  // Keep the initial fetch from overwriting what each test reports.
  vi.mocked(NetInfo.fetch).mockImplementation((() => new Promise(() => undefined)) as unknown as typeof NetInfo.fetch);
  useNetworkStore.setState({ online: true, connected: true, internetReachable: null, serverReachable: null });
  useNetworkStore.getState().init();
});

describe('network store: a reachable mail server', () => {
  it('a reachable server counts as online despite a failed internet probe', () => {
    netInfo(true, false);
    expect(useNetworkStore.getState().online).toBe(false);
    useNetworkStore.getState().noteServerResponse();
    expect(useNetworkStore.getState().serverReachable).toBe(true);
    expect(useNetworkStore.getState().online).toBe(true);
    expect(useNetworkStore.getState().connected).toBe(true);
  });

  it('no interface means offline', () => {
    netInfo(false, false);
    useNetworkStore.getState().noteServerResponse();
    expect(useNetworkStore.getState().online).toBe(false);
    netInfo(false, null);
    expect(useNetworkStore.getState().online).toBe(false);
  });

  it('a transport failure after a failed probe gives offline', () => {
    netInfo(true, false);
    useNetworkStore.getState().noteServerResponse();
    expect(useNetworkStore.getState().online).toBe(true);
    useNetworkStore.getState().noteServerUnreachable();
    expect(useNetworkStore.getState().serverReachable).toBe(false);
    expect(useNetworkStore.getState().online).toBe(false);
  });

  it('keeps a reachable server online when a later probe result fails', () => {
    netInfo(true, null);
    useNetworkStore.getState().noteServerResponse();
    netInfo(true, false);
    expect(useNetworkStore.getState().online).toBe(true);
  });

  it('a new connection resets serverReachable', () => {
    netInfo(true, false);
    useNetworkStore.getState().noteServerResponse();
    expect(useNetworkStore.getState().online).toBe(true);
    netInfo(false, false);
    expect(useNetworkStore.getState().online).toBe(false);
    netInfo(true, false);
    expect(useNetworkStore.getState().serverReachable).toBeNull();
    expect(useNetworkStore.getState().online).toBe(false);
  });

  it('a NetInfo event on the same connection keeps serverReachable', () => {
    netInfo(true, false);
    useNetworkStore.getState().noteServerResponse();
    netInfo(true, false);
    expect(useNetworkStore.getState().serverReachable).toBe(true);
  });

  it('the probe being null keeps today\'s behaviour', () => {
    netInfo(true, null);
    expect(useNetworkStore.getState().online).toBe(true);
    useNetworkStore.getState().noteServerUnreachable();
    expect(useNetworkStore.getState().online).toBe(true);
    netInfo(true, true);
    useNetworkStore.getState().noteServerUnreachable();
    expect(useNetworkStore.getState().online).toBe(true);
    netInfo(false, null);
    expect(useNetworkStore.getState().online).toBe(false);
  });

  it('stays online by default before NetInfo reports', () => {
    useNetworkStore.setState({ online: true, connected: true, internetReachable: null, serverReachable: null });
    useNetworkStore.getState().noteServerUnreachable();
    expect(useNetworkStore.getState().online).toBe(true);
  });

  it('fires one online edge when a server response follows a failed probe', () => {
    netInfo(true, false);
    const edges: boolean[] = [];
    const unsubscribe = useNetworkStore.subscribe((state, prev) => {
      if (state.online !== prev.online) edges.push(state.online);
    });
    useNetworkStore.getState().noteServerResponse();
    useNetworkStore.getState().noteServerResponse();
    unsubscribe();
    expect(edges).toEqual([true]);
  });

  it('does not notify subscribers for a repeated note', () => {
    netInfo(true, false);
    useNetworkStore.getState().noteServerResponse();
    const listenerSpy = vi.fn();
    const unsubscribe = useNetworkStore.subscribe(listenerSpy);
    useNetworkStore.getState().noteServerResponse();
    unsubscribe();
    expect(listenerSpy).not.toHaveBeenCalled();
  });

  it('receives the client\'s reports through the reachability relay', () => {
    netInfo(true, false);
    reportServerResponse();
    expect(useNetworkStore.getState().online).toBe(true);
    reportServerUnreachable();
    expect(useNetworkStore.getState().online).toBe(false);
  });
});
