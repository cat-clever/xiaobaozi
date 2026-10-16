#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(Ssdp, NSObject)

RCT_EXTERN_METHOD(discover:(nonnull NSNumber *)timeoutMs
                 resolver:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

@end
