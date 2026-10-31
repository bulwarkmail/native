// The texts of Settings > Security > TLS client certificate, per platform.
// Android picks a certificate installed in the system (KeyChain); iOS has no
// such store apps can pick from, so the user brings a .p12 or .pfx file that
// is imported into the app's keychain and removed again on Clear
// (plugins/ios-client-cert).

type Translate = (key: string, fallback: string) => string;

export interface ClientCertCopy {
  description: string;
  hint: string;
  clearMessage: string;
}

export function clientCertCopy(os: string, t: Translate): ClientCertCopy {
  if (os === 'ios') {
    return {
      description: t('settings.security.client_cert.description_ios', 'Imports a certificate file to authenticate to the server during the TLS handshake. Useful when the reverse proxy enforces mTLS.'),
      hint: t('settings.security.client_cert.hint_ios', 'Pick the certificate file (.p12 or .pfx) in Files and enter its password.'),
      clearMessage: t('settings.security.client_cert.clear_message_ios', 'New requests will no longer present a certificate. The certificate is removed from the app; to use it again, pick the file again.'),
    };
  }
  return {
    description: t('settings.security.client_cert.description', 'Picks an installed Android certificate to authenticate to the server during the TLS handshake. Useful when the reverse proxy enforces mTLS.'),
    hint: t('settings.security.client_cert.hint', 'Install the certificate via Android Settings → Security → Encryption & credentials, then pick it here.'),
    clearMessage: t('settings.security.client_cert.clear_message', 'New requests will no longer present a certificate. The certificate stays installed in Android.'),
  };
}
