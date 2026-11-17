// NativeModules.BulwarkScreenAwake: keeps the screen on while the phone is
// charging, for the desk inbox (src/components/DeskInbox.tsx).
//
//   setAwakeWhileCharging(enabled)  while enabled, the idle timer is off
//                                   whenever the battery is charging or full,
//                                   and on again when it is unplugged.
//
// On battery the screen dims and locks as iOS's Auto-Lock setting says.

#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>

@interface BulwarkScreenAwake : NSObject <RCTBridgeModule>
@end

@implementation BulwarkScreenAwake {
  BOOL _enabled;
}

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup { return NO; }

// UIDevice and UIApplication are main-thread APIs.
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

RCT_EXPORT_METHOD(setAwakeWhileCharging:(BOOL)enabled)
{
  if (enabled == _enabled) return;
  _enabled = enabled;
  UIDevice *device = UIDevice.currentDevice;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  if (enabled) {
    device.batteryMonitoringEnabled = YES;
    [center addObserver:self selector:@selector(apply) name:UIDeviceBatteryStateDidChangeNotification object:nil];
  } else {
    [center removeObserver:self name:UIDeviceBatteryStateDidChangeNotification object:nil];
    device.batteryMonitoringEnabled = NO;
  }
  [self apply];
}

- (void)apply
{
  UIDeviceBatteryState state = UIDevice.currentDevice.batteryState;
  BOOL plugged = state == UIDeviceBatteryStateCharging || state == UIDeviceBatteryStateFull;
  UIApplication.sharedApplication.idleTimerDisabled = _enabled && plugged;
}

- (void)invalidate
{
  [NSNotificationCenter.defaultCenter removeObserver:self];
  UIApplication.sharedApplication.idleTimerDisabled = NO;
}

@end
