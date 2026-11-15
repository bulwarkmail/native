// Config plugin: the hinge of a foldable iPhone (the iPhone Duo).
//
// Compiles the BulwarkHinge native module (BulwarkHinge.m) into the app. It
// reports UIKit's hinge state (UIHingeInteraction, iOS 27.1) to
// src/lib/device-hinge.ts, which tells a Duo standing as a tent from one
// held in the hand.

const { createRunOncePlugin } = require('@expo/config-plugins');
const { withAppSources } = require('../ios-app-sources');

const FILES = ['BulwarkHinge.m'];

function withIosHinge(config) {
  return withAppSources(config, { dir: __dirname, files: FILES });
}

module.exports = createRunOncePlugin(withIosHinge, 'bulwark-ios-hinge', '1.0.0');
module.exports.FILES = FILES;
