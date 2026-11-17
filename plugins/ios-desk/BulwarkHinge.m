// NativeModules.BulwarkHinge: the hinge of a foldable iPhone, for
// src/lib/device-hinge.ts.
//
// Emits "hinge" with { status, angle } whenever UIKit's hinge state changes,
// and once when observing starts: `status` is UIHinge.Status's raw value,
// `angle` the hinge angle in degrees. Emits { status: null } when the window
// has no hinge (any device but a foldable).
//
// UIHingeInteraction is new in the iOS 27.1 SDK and the release builds are
// made with an older one, so the class is looked up at run time: on an
// older SDK or system the module simply never reports a hinge.

#import <React/RCTEventEmitter.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <objc/message.h>

@interface BulwarkHinge : RCTEventEmitter <RCTBridgeModule>
@end

@implementation BulwarkHinge {
  id<UIInteraction> _interaction;
  NSDictionary *_last;
}

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup { return NO; }

// UIKit's interaction lives on the main thread, and so does every method.
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }

- (NSArray<NSString *> *)supportedEvents { return @[@"hinge"]; }

- (void)startObserving
{
  [self attach];
}

- (void)stopObserving
{
  [[NSNotificationCenter defaultCenter] removeObserver:self name:UIWindowDidBecomeKeyNotification object:nil];
  [self detach];
}

// Listening before the app's window is up: attach once it is.
- (void)windowBecameKey:(NSNotification *)note
{
  [[NSNotificationCenter defaultCenter] removeObserver:self name:UIWindowDidBecomeKeyNotification object:nil];
  [self attach];
}

- (void)attach
{
  if (_interaction) return;
  Class interactionClass = NSClassFromString(@"UIHingeInteraction");
  SEL init = NSSelectorFromString(@"initWithUpdateHandler:");
  if (!interactionClass || ![interactionClass instancesRespondToSelector:init]) {
    [self report:@{ @"status": [NSNull null] }];
    return;
  }
  UIView *root = RCTKeyWindow().rootViewController.view;
  if (!root) {
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(windowBecameKey:)
                                                 name:UIWindowDidBecomeKeyNotification object:nil];
    return;
  }
  __weak BulwarkHinge *weakSelf = self;
  // The update and the hinge are read by key, as the classes are not in the
  // SDK the app is built with; a key UIKit ever renamed reads as no hinge
  // rather than taking the app down.
  void (^handler)(id, id) = ^(id interaction, id update) {
    NSDictionary *state = @{ @"status": [NSNull null] };
    @try {
      id hinge = [update valueForKey:@"hinge"];
      if (hinge) {
        double radians = [[hinge valueForKey:@"angle"] doubleValue];
        state = @{
          @"status": [hinge valueForKey:@"status"] ?: [NSNull null],
          // Whole degrees: finer than that is noise to the app, and each change crosses the bridge.
          @"angle": @(round(radians * 180.0 / M_PI)),
        };
      }
    } @catch (NSException *e) {
      state = @{ @"status": [NSNull null] };
    }
    [weakSelf report:state];
  };
  id interaction = ((id (*)(id, SEL, id))objc_msgSend)([interactionClass alloc], init, handler);
  if (!interaction) return;
  _interaction = interaction;
  [root addInteraction:_interaction];
}

- (void)detach
{
  if (!_interaction) return;
  [_interaction.view removeInteraction:_interaction];
  _interaction = nil;
}

- (void)report:(NSDictionary *)state
{
  if ([state isEqualToDictionary:_last]) return;
  _last = state;
  [self sendEventWithName:@"hinge" body:state];
}

// The last state, for a listener that subscribes after the first report.
RCT_EXPORT_METHOD(current:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
  resolve(_last ?: [NSNull null]);
}

@end
