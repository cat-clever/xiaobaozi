#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(Updater, NSObject)

RCT_EXTERN_METHOD(getVersion:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

@end
