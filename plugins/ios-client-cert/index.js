// Config plugin: TLS client certificates on iOS (#3).
//
// Compiles the BulwarkClientCert native module (BulwarkClientCert.swift, and
// BulwarkClientCert.m that registers it with React Native) into the app. It
// has the methods of Android's BulwarkClientCertModule.kt, so
// src/lib/client-cert.ts works the same on both.

const { createRunOncePlugin } = require('@expo/config-plugins');
const { withAppSources } = require('../ios-app-sources');

const FILES = ['BulwarkClientCert.swift', 'BulwarkClientCert.m'];

function withIosClientCert(config) {
  return withAppSources(config, { dir: __dirname, files: FILES });
}

module.exports = createRunOncePlugin(withIosClientCert, 'bulwark-ios-client-cert', '1.0.0');
module.exports.FILES = FILES;
