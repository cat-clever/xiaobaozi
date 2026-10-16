#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ScreenControl, NSObject)

RCT_EXTERN_METHOD(setBrightness:(double)value
                 resolve:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setPipAspectRatio:(double)width
                 height:(double)height
                 resolve:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setOrientation:(NSString *)mode
                 resolve:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

@end
