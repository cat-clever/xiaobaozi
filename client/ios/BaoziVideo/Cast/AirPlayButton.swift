import AVKit
import React
import UIKit

/**
 * 系统的 AirPlay 路由选择器（`AVRoutePickerView`）。
 *
 * ★★ **AirPlay 只能用系统的这套** —— 苹果没有公开"自己发现 AirPlay 设备 /
 *   自己发起投屏"的 API，第三方 App 一律是把这个系统控件摆出来，由系统弹
 *   路由列表（Apple TV、支持 AirPlay 2 的电视、蓝牙音频…）。
 *   想"自绘一个设备列表然后投过去"在 iOS 上做不到，也不该做。
 *
 * ★ 真正让画面走 AirPlay 的是播放器那一侧的 `allowsExternalPlayback`
 *   （`react-native-video` 的 prop，见 `PlayerScreen`）——
 *   这个控件只负责**让用户挑设备**。
 *
 * ★ `prioritizesVideoDevices = true`：不打开的话列表里排前面的是音频路由，
 *   投视频时会被"只支持音频"的设备误导。
 */
@objc(AirPlayButtonView)
final class AirPlayButtonView: UIView {

  private let picker = AVRoutePickerView()

  /// 图标颜色（不传就用系统默认）
  @objc var iconColor: UIColor? {
    didSet { picker.tintColor = iconColor ?? UIView().tintColor }
  }

  /// 正在投屏时的高亮色
  @objc var activeIconColor: UIColor? {
    didSet { picker.activeTintColor = activeIconColor ?? iconColor ?? UIView().tintColor }
  }

  @objc var prioritizesVideoDevices: Bool = true {
    didSet { picker.prioritizesVideoDevices = prioritizesVideoDevices }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    picker.prioritizesVideoDevices = true
    picker.translatesAutoresizingMaskIntoConstraints = false
    addSubview(picker)
    NSLayoutConstraint.activate([
      picker.leadingAnchor.constraint(equalTo: leadingAnchor),
      picker.trailingAnchor.constraint(equalTo: trailingAnchor),
      picker.topAnchor.constraint(equalTo: topAnchor),
      picker.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }
}

/** RN 侧的视图管理器。属性名与 TS 里传的一致 */
@objc(AirPlayButtonManager)
final class AirPlayButtonManager: RCTViewManager {

  // ★ 必须带 `override`（同 GlassViewManager 那条注释：`RCTBridgeModule`
  //   协议里已经声明过，Swift 认为子类实现它算覆盖）
  override static func requiresMainQueueSetup() -> Bool { true }

  override func view() -> UIView! { AirPlayButtonView() }
}
