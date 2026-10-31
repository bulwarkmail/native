// Exposes BulwarkClientCert.swift to React Native as NativeModules.BulwarkClientCert,
// with the methods of Android's BulwarkClientCertModule.kt.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(BulwarkClientCert, NSObject)

RCT_EXTERN_METHOD(getAlias:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(clearAlias:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(pickAlias:(NSString *)host resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(fetchSecure:(NSDictionary *)request resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

@end
