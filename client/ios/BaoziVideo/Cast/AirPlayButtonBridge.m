#import <React/RCTViewManager.h>

/**
 * Swift 写的视图管理器没法直接 RCT_EXPORT_MODULE，用这个 ObjC 壳暴露给 RN。
 * 类名与 `AirPlayButton.swift` 上的 `@objc(AirPlayButtonManager)` 必须一致。
 */
@interface RCT_EXTERN_MODULE(AirPlayButtonManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(iconColor, UIColor)
RCT_EXPORT_VIEW_PROPERTY(activeIconColor, UIColor)
RCT_EXPORT_VIEW_PROPERTY(prioritizesVideoDevices, BOOL)

@end
