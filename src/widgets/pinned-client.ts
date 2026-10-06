import type { JMAPClient } from '../api/jmap-client';

/**
 * The app's client, held to the connection it serves right now. A widget
 * action reads before it writes (Mailbox/get, then Email/set); if the app
 * switches account in between, the write must not go out on the new
 * connection with the old account's ids, which on Stalwart name the other
 * account's mail. Each request carries the generation captured here, so a
 * request after a switch is refused before it is sent (`StaleLoadError`).
 */
export function pinToConnection(client: JMAPClient): JMAPClient {
  const gen = client.connectionGen;
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'request') {
        return (calls: Parameters<JMAPClient['request']>[0], using?: string[]) =>
          target.request(calls, using, { gen });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
