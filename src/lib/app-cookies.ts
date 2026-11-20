// The app's own requests keep the cookies a server, or a proxy in front of it,
// sets: React Native's networking stores them (on Android in the WebView
// cookie store, which file transfers read too). Once the last account is
// signed out nothing may still carry a session, so they all go.
type Networking = { clearCookies(callback: (cleared: boolean) => void): void };

export function clearAppCookies(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const networking = (require('react-native/Libraries/Network/RCTNetworking') as { default: Networking }).default;
      networking.clearCookies(() => resolve());
    } catch (err) {
      console.warn('[app-cookies] could not clear the cookies:', err);
      resolve();
    }
  });
}
