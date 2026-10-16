import UIKit
import React

/**
 * 液态玻璃容器（iOS 侧）。
 *
 * 两条路：
 *
 *   - **iOS 26+（有 iOS 26 SDK 就有，编译期用 `#available` 分岔）**：
 *     真·液态玻璃 `UIGlassEffect` —— 真折射的材质、自带边缘高光，
 *     并且 `isInteractive = true` 时**按住会扩张 + 起高光**
 *     （就是系统 Tab 栏那个手感，不是我们自己拿动画凑的）。
 *   - **iOS 15.1 ~ 25**：系统没这个材质，退回
 *     `UIBlurEffect` + 上缘高光 + 描边 的近似。
 *
 * ★★ 层级照 Apple 官方文档《Implementing Liquid Glass Design in UIKit》里
 *    那个"带自定义内容 + 可交互"的玻璃卡片例子摆：**玻璃垫在下面，
 *    内容（RN 的 children）由 `GlassBox` 摆在玻璃上面当兄弟节点**。
 *    本视图**不接管** RN 的子节点。
 *
 * ★ 这里踩过一次坑，别再走回头路：曾经为了让玻璃"收到触摸"，
 *   把 RN 的 children 接管过来塞进 `effectView.contentView` ——
 *   真机上 **iOS 26 整条 Tab 栏直接看不见**。官方样例不是那种结构，
 *   而且玻璃要能被命中，靠的是别在 RN 侧挂 `pointerEvents="none"`
 *   （见 `GlassBox.tsx`），不是把内容塞进玻璃。
 */
@objc(GlassView)
final class GlassView: UIView {

  private let effectView = UIVisualEffectView(effect: nil)
  private let highlightLayer = CAGradientLayer()
  private let borderLayer = CAShapeLayer()

  /// 圆角。RN 侧传进来
  @objc var cornerRadius: NSNumber = 22 {
    didSet { applyAppearance() }
  }

  /// "dark" / "light" —— 决定用哪套材质与高光强度
  @objc var glassStyle: NSString = "dark" {
    didSet { applyAppearance() }
  }

  /**
   * 真玻璃**按住会不会动**（iOS 26+ 才有意义；低版本忽略）。
   *
   * ★ 只给 Tab 栏开。开了之后玻璃要能收到触摸，所以 RN 那边会去掉
   *   `pointerEvents="none"`（见 `GlassBox.tsx`）—— 两个开关是配套的。
   */
  @objc var interactive: Bool = false {
    didSet { applyAppearance() }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    clipsToBounds = true

    // 玻璃层垫在最底下；RN 的内容在 GlassBox 那层垫在它上面（兄弟节点）
    addSubview(effectView)

    highlightLayer.locations = [0.0, 0.12, 1.0]
    layer.addSublayer(highlightLayer)

    borderLayer.fillColor = UIColor.clear.cgColor
    layer.addSublayer(borderLayer)

    applyAppearance()
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    effectView.frame = bounds
    highlightLayer.frame = bounds
    borderLayer.frame = bounds
    borderLayer.path = UIBezierPath(
      roundedRect: bounds,
      cornerRadius: CGFloat(truncating: cornerRadius)
    ).cgPath
  }

  private func applyAppearance() {
    let isLight = (glassStyle as String) == "light"
    let radius = CGFloat(truncating: cornerRadius)

    layer.cornerRadius = radius
    // ★ 圆角要落在**玻璃层**上：真玻璃是个材质，不裁的话是个直角，
    //   叠在胶囊上会露出方角。
    effectView.layer.cornerRadius = radius
    effectView.clipsToBounds = true

    // ★ 材质的明暗跟**应用主题**走，不跟系统外观走。
    //   App 自己的深色主题与系统设置是两回事：系统浅色 + App 深色时不指定，
    //   玻璃会按浅色材质渲染，糊在深色页面上就是一块刺眼的亮。
    overrideUserInterfaceStyle = isLight ? .light : .dark

    if #available(iOS 26.0, *) {
      let glass = UIGlassEffect(style: .regular)
      // 交互：按住会扩张、点亮、跟着手指走
      glass.isInteractive = interactive
      effectView.effect = glass

      // ★ 真玻璃自带边缘高光与折射，自己再叠一层高光/描边只会显脏
      highlightLayer.isHidden = true
      borderLayer.isHidden = true
    } else {
      // ★ 浅色主题要用亮材质，否则在浅背景上糊成一块灰
      effectView.effect = UIBlurEffect(
        style: isLight ? .systemUltraThinMaterialLight : .systemUltraThinMaterialDark
      )

      highlightLayer.isHidden = false
      borderLayer.isHidden = false

      // 上缘高光：玻璃边缘"折光"的那一道
      highlightLayer.colors = isLight
        ? [UIColor(white: 1.0, alpha: 0.85).cgColor,
           UIColor(white: 1.0, alpha: 0.28).cgColor,
           UIColor(white: 1.0, alpha: 0.0).cgColor]
        : [UIColor(white: 1.0, alpha: 0.34).cgColor,
           UIColor(white: 1.0, alpha: 0.10).cgColor,
           UIColor(white: 1.0, alpha: 0.0).cgColor]

      borderLayer.strokeColor = (isLight
        ? UIColor(white: 1.0, alpha: 0.85)
        : UIColor(white: 1.0, alpha: 0.22)).cgColor
      borderLayer.lineWidth = 1.0 / UIScreen.main.scale
    }

    setNeedsLayout()
  }
}

/** RN 侧的视图管理器。属性名与 TS 里传的一致 */
@objc(GlassViewManager)
final class GlassViewManager: RCTViewManager {
  // ★ 这里**必须**带 `override`。
  //   `RCTViewManager` 自己没实现这个方法，但它 conform 了 `RCTBridgeModule`，
  //   而 `requiresMainQueueSetup` 就声明在那个协议里 —— Swift 认为该要求已由
  //   父类的 conformance 满足，所以子类实现它算"覆盖"，漏了 override 会报
  //   "overriding declaration requires an 'override' keyword"。
  //   ★ 必须返回 true：UIView 只能在主线程建。
  override static func requiresMainQueueSetup() -> Bool { true }

  override func view() -> UIView! { GlassView() }
}
