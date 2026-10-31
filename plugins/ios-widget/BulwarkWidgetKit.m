// Exposes BulwarkWidgetKit.swift to React Native as NativeModules.BulwarkWidgetKit.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(BulwarkWidgetKit, NSObject)

RCT_EXTERN_METHOD(reloadAll:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(placedCount:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

@end
