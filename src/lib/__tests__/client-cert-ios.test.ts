import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { clientCertModuleOf } from '../client-cert';

// TLS client certificates on iOS (#3). The app used the native module on
// Android only; iOS now has one with the same methods (plugins/ios-client-cert),
// so client-cert.ts takes the module wherever react-native offers it.

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('client-cert.ts on iOS', () => {
  it('uses the BulwarkClientCert module whatever the platform', () => {
    const module = { getAlias: vi.fn(), pickAlias: vi.fn(), clearAlias: vi.fn(), fetchSecure: vi.fn() };
    expect(clientCertModuleOf({ NativeModules: { BulwarkClientCert: module } })).toBe(module);
    expect(clientCertModuleOf({ NativeModules: {} })).toBeNull();
    expect(read('src/lib/client-cert.ts')).not.toMatch(/Platform\.OS !== 'android'/);
  });
});

describe('the iOS BulwarkClientCert module', () => {
  const bridge = read('plugins/ios-client-cert/BulwarkClientCert.m');
  const swift = read('plugins/ios-client-cert/BulwarkClientCert.swift');
  const kotlin = read('android/app/src/main/java/com/anonymous/bulwarkmobile/BulwarkClientCertModule.kt');

  const selectors = [...bridge.matchAll(/RCT_EXTERN_METHOD\(([\s\S]*?)\)\r?\n/g)].map((m) =>
    // "pickAlias:(NSString *)host resolver:(...)resolve rejecter:(...)reject" -> "pickAlias:resolver:rejecter:"
    m[1].replace(/\([^)]*\)\w+/g, '').replace(/\s+/g, ''),
  );

  it('registers under the Android module\'s name with the same methods', () => {
    expect(bridge).toContain('@interface RCT_EXTERN_MODULE(BulwarkClientCert, NSObject)');
    expect(kotlin).toContain('const val MODULE_NAME = "BulwarkClientCert"');
    const jsNames = selectors.map((s) => s.split(':')[0]).sort();
    const androidNames = [...kotlin.matchAll(/@ReactMethod\s+fun (\w+)\(/g)].map((m) => m[1]).sort();
    expect(jsNames).toEqual(androidNames);
    expect(jsNames).toEqual(['clearAlias', 'fetchSecure', 'getAlias', 'pickAlias']);
  });

  it('implements every exported selector in Swift', () => {
    expect(swift).toContain('@objc(BulwarkClientCert)');
    for (const selector of selectors) expect(swift).toContain(`@objc(${selector})`);
  });

  it('answers client-certificate challenges and leaves server trust to the system', () => {
    expect(swift).toMatch(/authenticationMethod == NSURLAuthenticationMethodClientCertificate/);
    expect(swift).toContain('completionHandler(.useCredential, credential)');
    expect(swift).toContain('completionHandler(.performDefaultHandling, nil)');
  });

  it('hands redirects back to JS, which follows only same-host hops', () => {
    const redirect = swift.slice(swift.indexOf('willPerformHTTPRedirection'));
    expect(redirect.slice(0, 400)).toContain('completionHandler(nil)');
  });

  it('resolves fetchSecure with the shape secureFetch rebuilds a Response from', () => {
    for (const key of ['"status"', '"statusText"', '"headers"', '"bodyBase64"']) expect(swift).toContain(key);
  });

  it('is compiled into the app by its config plugin', () => {
    const plugin = createRequire(__filename)(path.join(ROOT, 'plugins/ios-client-cert/index.js')) as { FILES: string[] };
    expect(plugin.FILES).toEqual(['BulwarkClientCert.swift', 'BulwarkClientCert.m']);
    expect(read('app.config.js')).toContain("'./plugins/ios-client-cert'");
  });
});
