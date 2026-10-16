#import <React/RCTViewManager.h>

/**
 * Swift 写的视图管理器没法直接 RCT_EXPORT_MODULE，用这个 ObjC 壳暴露给 RN。
 * 类名与 `GlassView.swift` 上的 `@objc(GlassViewManager)` 必须一致。
 */
@interface RCT_EXTERN_MODULE(GlassViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(cornerRadius, NSNumber)
RCT_EXPORT_VIEW_PROPERTY(glassStyle, NSString)
RCT_EXPORT_VIEW_PROPERTY(interactive, BOOL)

@end
