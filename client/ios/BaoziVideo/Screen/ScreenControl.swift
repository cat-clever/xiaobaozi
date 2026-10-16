import Foundation
import UIKit
import React

/**
 * 播放页要用的少量系统能力：屏幕亮度、屏幕方向。
 *
 * ★ 单独立一个模块，不塞进 `MediaServer` —— 那边只管取流，两件事混在一起以后不好维护。
 *
 * ★ 方向用的是 iOS 16 起的**公开 API** `requestGeometryUpdate`，
 *   而不是 `UIDevice.setValue(_:forKey:"orientation")` 那种私有 KVC ——
 *   后者有审核风险，项目文档 §9.2.12 明确不引入。
 */
@objc(ScreenControl)
final class ScreenControl: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { false }

  /** value 取值 0..1 */
  @objc func setBrightness(_ value: Double,
                           resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      UIScreen.main.brightness = CGFloat(max(0.0, min(1.0, value)))
      resolve(nil)
    }
  }

  /**
   * 画中画比例 —— **iOS 确实不需要做任何事**，这是个有意的空实现。
   *
   * 依据（`react-native-video` 的 iOS 实现）：
   *
   *     // RCTPictureInPicture.swift:61
   *     _pipController = AVPictureInPictureController(playerLayer: playerLayer)
   *
   *   PiP 控制器是**直接挂在 `AVPlayerLayer` 上**的 —— 画中画窗里显示的就是
   *   这个图层，系统会按图层的 `videoRect`（也就是视频本身的宽高比）来定窗口
   *   形状。iOS 上**没有**对应的 `setAspectRatio` 这种 API，也不需要。
   *
   *   对照 Android：那边用的是 `PictureInPictureParams.setAspectRatio()`，
   *   而且 react-native-video 只在**手动**进画中画时才设、上滑自动进入不设，
   *   所以安卓侧必须自己补一次。
   *
   * 留这个空实现只是为了让 JS 侧两端调用一致（方法不存在的话 RN 会抛错）。
   */
  @objc func setPipAspectRatio(_ width: Double,
                               height: Double,
                               resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(nil)
  }

  /** 'landscape' / 'portrait' / 'auto' */
  @objc func setOrientation(_ mode: String,
                            resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      if #available(iOS 16.0, *) {
        guard let scene = UIApplication.shared.connectedScenes
          .compactMap({ $0 as? UIWindowScene })
          .first(where: { $0.activationState == .foregroundActive })
        else {
          resolve(nil)
          return
        }

        let mask: UIInterfaceOrientationMask
        switch mode {
        case "landscape": mask = .landscape
        case "portrait": mask = .portrait
        default: mask = .allButUpsideDown
        }

        // ★ 这一步只有在 Info.plist 的 UISupportedInterfaceOrientations 里
        //   也放开了对应方向时才生效
        let preferences = UIWindowScene.GeometryPreferences.iOS(interfaceOrientations: mask)
        scene.requestGeometryUpdate(preferences) { _ in }
      }
      resolve(nil)
    }
  }
}
