// Config plugin: the desk inbox of an iPhone Duo standing as a tent
// (src/components/DeskInbox.tsx).
//
// Compiles two native modules into the app: BulwarkHinge.m reports UIKit's
// hinge state (UIHingeInteraction, iOS 27.1) to src/lib/device-hinge.ts,
// which tells a Duo standing as a tent from one held in the hand, and
// BulwarkScreenAwake.m keeps the screen on while it charges.

const { createRunOncePlugin } = require('@expo/config-plugins');
const { withAppSources } = require('../ios-app-sources');

const FILES = ['BulwarkHinge.m', 'BulwarkScreenAwake.m'];

function withIosDesk(config) {
  return withAppSources(config, { dir: __dirname, files: FILES });
}

module.exports = createRunOncePlugin(withIosDesk, 'bulwark-ios-desk', '1.0.0');
module.exports.FILES = FILES;
