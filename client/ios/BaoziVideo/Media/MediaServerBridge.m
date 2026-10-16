#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

/**
 * Swift 类没法直接 RCT_EXPORT_MODULE，用这个 ObjC 壳把 `MediaServer` 暴露给 RN。
 * 类名与 `MediaServer.swift` 上的 `@objc(MediaServer)` 必须一致。
 */
@interface RCT_EXTERN_MODULE(MediaServer, RCTEventEmitter)

RCT_EXTERN_METHOD(start:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(createSession:(NSString *)sid
                 configJson:(NSString *)configJson
                 resolve:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(closeSession:(NSString *)sid
                 resolve:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(respondPlaylist:(NSString *)reqId
                 text:(NSString *)text
                 resolve:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(fetchText:(NSString *)sid
                 url:(NSString *)url
                 resolve:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(prepareRemux:(NSString *)sid
                 segmentUrl:(NSString *)segmentUrl
                 resolve:(RCTPromiseResolveBlock)resolve
                 rejecter:(RCTPromiseRejectBlock)reject)

@end
