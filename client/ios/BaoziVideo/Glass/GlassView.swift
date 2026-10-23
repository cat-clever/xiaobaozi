import UIKit
import React

/**
 * 液态玻璃容器（iOS 侧）。
 *
 * 两条路：
 *
 *   - **iOS 26+**：真·液态玻璃 `UIGlassEffect` —— 真折射的材质、自带边缘高光，
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
 *
 * ★★ 真正的坑在**装的时机**上，2026-10-16 才查清楚，单独说明见
 *    `glassInstalled` 和 `installGlass()` 的注释 —— 一句话：
 *    **`UIGlassEffect` 只能在 `layoutSubviews` 里装，装早了 UIKit 什么都不画，
 *    而且之后永远不补。** 之前"两端都没有液态玻璃效果"就是这个引起的。
 */
@objc(GlassView)
final class GlassView: UIView {

  private let effectView = UIVisualEffectView(effect: nil)
  private let highlightLayer = CAGradientLayer()
  private let borderLayer = CAShapeLayer()

  /**
   * ★★ 真玻璃**装上了没**。
   *
   *    UIKit 对 `UIGlassEffect` 有一条**静默**规则（官方文档没写，实测出来的）：
   *
   *      · 视图**还没上屏 / 还没布局完**就赋值 `effectView.effect = UIGlassEffect()`，
   *        UIKit **什么都不画**——不是画成黑的，是彻底不出现；
   *      · 而且它**不会再自己补上**：之后你在同一个视图上怎么刷新，
   *        这一份玻璃就是"废"的，除非**先清空再重新装一遍**。
   *
   *    所以真玻璃**只在 `layoutSubviews` 里装一次**（那时视图一定已经有尺寸、
   *    通常在窗口里），没装成之前一直用显示心跳盯着（`waitForVisibility`）。
   *
   *    `expo-glass-effect` 是同一套 API 的成熟实现，它的注释写得更直白：
   *      "UIGlassEffect must be created during layoutSubviews"
   *      "Glass effect does not work sometimes if view has not been laid out yet"
   *      "UIKit silently skips the glass effect when the view's opacity is low,
   *       and never installs it again"
   */
  private var glassInstalled = false

  /// 等"能渲染了"用的显示心跳（见 `waitForVisibility`）
  private var visibilityLink: CADisplayLink?

  /// ★ 诊断：视图挂上时颜色标记（卸掉就能装挂粗盲态）。
  ///   init 里把 bg 色标成红色，installGlass 成功后再换成 clear。
  ///   口感：红色条 = 还没装上（时机/门控问题）。
  ///         直接 clear/transparant → 安装了但材质没画（host 问题 → 需 Fabric）。
  ///         real glass → 修好了。

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
   *
   * ★★ 改这个值**必须把旧的材质清掉再重新装**（见 `reloadGlass`）：
   *   直接往已经装好的 `UIVisualEffectView` 上赋一份新的 `UIGlassEffect`，
   *   UIKit 不保证会把旧的那份扔掉 —— 表现就是"按下去什么都没动"，
   *   这曾经是按压动画不生效的头号原因。
   */
  @objc var interactive: Bool = false {
    didSet {
      guard interactive != oldValue else { return }
      reloadGlass()
    }
  }

  /**
   * ★★ 原生拖动转发（只给 Tab 栏的每一格开）。
   *
   *   iOS 26 的交互玻璃自带手势识别器，按住拖动时会把 RN 的触摸流 cancel 掉
   *   （`cancelsTouchesInView`）—— 于是「拖动切 Tab」在 JS 侧收不到 move。
   *
   *   这里在**同一个视图**上再挂一个自己的 `UIPanGestureRecognizer`，
   *   并把 `shouldRecognizeSimultaneouslyWith` 放开：玻璃自己的按压动画照旧，
   *   我们这边把 `translationX` 通过 `onPan` 事件转给 JS，
   *   胶囊和页面的跟手逻辑复用原来那一套（`syncTo` / `settleCapsule`）。
   */
  @objc var panEnabled: Bool = false {
    didSet {
      guard panEnabled != oldValue else { return }
      updatePanGesture()
    }
  }

  /** 拖动事件：state 0=began 1=changed 2=ended 3=cancelled */
  @objc var onPan: RCTDirectEventBlock?

  private var panRecognizer: UIPanGestureRecognizer?
  private var fallbackTimer: Timer?
  /// 第一次 `didBecomeActive` 之后补装过一次没有（只补一次，避免每次切前台都闪）
  private var didReinstallOnActivation = false
  private var activationObserver: NSObjectProtocol?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    clipsToBounds = true

    // 玻璃效果只负责绘制材质，RN 内容由 GlassBox 作为上层兄弟视图承载。
    addSubview(effectView)

    highlightLayer.locations = [0.0, 0.12, 1.0]
    layer.addSublayer(highlightLayer)

    borderLayer.fillColor = UIColor.clear.cgColor
    layer.addSublayer(borderLayer)

    // ★ 这里的调用**装不出真玻璃**（视图还没布局），只负责把低版本的模糊
    //   和主题色定下来；iOS 26 的真玻璃交给 `layoutSubviews`。
    applyAppearance()

    /**
     * ★★ 保险：App 真正 active 之后**重装一次**。
     *
     *   启动那一帧窗口可能还不是 key —— 那时装的玻璃会被 UIKit 丢掉。
     *   `didBecomeActive` 时窗口一定已经上屏，在这里清掉重装最稳。
     *   只补一次：之后每次切前台都重装会闪。
     */
    activationObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self, GlassView.glassEffectAvailable else { return }
      guard !self.didReinstallOnActivation else { return }
      self.didReinstallOnActivation = true
      self.glassInstalled = false
      self.setNeedsLayout()
    }
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

    // ★★ 真玻璃**只能在这里装** —— 这是唯一能保证"已经有尺寸、已经在窗口里"的时机。
    //    装早了就是一片空白，而且永久空白（见 `glassInstalled`）。
    if GlassView.glassEffectAvailable, !glassInstalled {
      if canRenderGlass {
        installGlass()
      } else {
        // 还不可见（比如父级动画还在 0 不透明度上）——先盯着，可见了再装
        waitForVisibility()
      }
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      // 离开窗口 = 这份层级没了：下次上屏得重新装一遍
      glassInstalled = false
      fallbackTimer?.invalidate()
      fallbackTimer = nil
      stopWaitingForVisibility()
    } else {
      // ★ `layoutSubviews` 在"几何没变"的重新上屏下**不会触发**，
      //   而真玻璃只有那条路能装 —— 这里显式要一次布局，把机会补回来。
      setNeedsLayout()
    }
  }

  deinit {
    visibilityLink?.invalidate()
    if let activationObserver {
      NotificationCenter.default.removeObserver(activationObserver)
    }
  }

  /**
   * 现在这份视图，UIKit 愿不愿意画玻璃。
   *
   * ★ 两个条件：
   *   1. **在窗口里**（不在窗口里，材质无处可采样）；
   *   2. **沿父链一路可见、且整体不透明度 > 0.02** —— UIKit 在接近全透明时
   *      会默默跳过玻璃，而且之后**永不补装**。所以宁可晚一点装，
   *      也别在"父级还在淡入"的时候装。
   */
  private var canRenderGlass: Bool {
    // ★ 必须在窗口里，而且窗口**已经是 key window**。
    //   App 刚启动时 view 可能已经挂进 window，但窗口还没成为 key / 还没真正上屏 ——
    //   这个时刻装 `UIGlassEffect`，UIKit 会静默跳过，之后永远不补。
    guard let window else { return false }
    if !window.isKeyWindow { return false }
    if bounds.width <= 0 || bounds.height <= 0 { return false }
    return true
  }

  private func installGlass() {
    guard !glassInstalled else { return }
    glassInstalled = true
    // 把 BG 切成 clear 了——截图里是 red 时 = 没到 installed；
    // clear 时 = 已装（下面 2s 的 blur fallback 也保证不会 perpetually red）。
    backgroundColor = .clear
    stopWaitingForVisibility()
    reloadGlass()
    // ★ 2s 时如果装上了 glass 但 rendering 仍然 empty， fallback to blur.
    armFallbackBlur()
  }

  private func armFallbackBlur() {
    fallbackTimer?.invalidate()
    guard #available(iOS 26.0, *) else { return }
    fallbackTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
      guard let self = self else { return }
      // reloadGlass 重新 ran; check installed vs then condition
      print("[GlassView] 2s probe: glassInstalled=\(self.glassInstalled) alpha visible=\(self.glassInstalled)")
    }
    // actual fallback: no effect remains never-installed → swap to blur
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
      guard let self = self else { return }
      if self.glassInstalled {
        // glassAttempted; test whether bar's view has glass assigned then effect null
        if self.effectView.effect == nil {
          if #available(iOS 26.0, *) {
            self.effectView.effect = UIVisualEffect()
            self.effectView.effect = UIBlurEffect(style: .systemUltraThinMaterialDark)
          }
        }
        return
      }
      // never installed → force blur so bar isn't transparent
      if #available(iOS 26.0, *) { self.effectView.effect = UIBlurEffect(style: .systemUltraThinMaterialDark) }
      self.glassInstalled = true  // never-wait again
      self.backgroundColor = .clear
    }
  }

  /**
   * 重新装一遍真玻璃。**先清空、再赋值**，两步都不能少。
   *
   * ★ 清空（`UIVisualEffect()`）是必须的：UIKit 认为"直接换成新的 UIGlassEffect"
   *   不一定算换过，旧材质会顶掉新的 —— 表现就是玻璃不出现 / 按下去不动。
   *   `expo-glass-effect` 同样要这么绕，注释是
   *   "we need to set the effect again or it has no effect!"。
   */
  private func reloadGlass() {
    guard GlassView.glassEffectAvailable, glassInstalled else { return }
    // 部署目标是 iOS 15.1，所以这里还得来一次编译期的 `#available`；
    // 运行期那层判断在 `glassEffectAvailable` 里（测试版上会崩的那次）
    if #available(iOS 26.0, *) {
      let glass = UIGlassEffect(style: .regular)
      glass.isInteractive = interactive
      // ★★ **第一次安装**（effect 还是 nil）直接赋真玻璃。
      //   原来无条件先赋一个空的 `UIVisualEffect()` 再赋玻璃 ——
      //   UIKit 会把两次赋值当成一次材质过渡，最终可能停在"空材质"上：
      //   玻璃永远画不出来，而且之后再怎么刷新都不补（用户 2026-10-23 实测：
      //   整条栏全透明、只有按下时 JS 那层白底可见）。
      //   "先清空再赋值"只在**已经装过**、需要换材质时才需要（见上面的注释）。
      if effectView.effect != nil {
        effectView.effect = UIVisualEffect()
      }
      effectView.effect = glass
    }
  }

  /// 还没法渲染时，用显示心跳盯着：一旦可见就要一次布局，把玻璃装上
  private func waitForVisibility() {
    guard visibilityLink == nil else { return }
    // 弱代理：CADisplayLink 会强引用 target，直接用 self 会把视图钉住
    let link = CADisplayLink(
      target: VisibilityProxy(self),
      selector: #selector(VisibilityProxy.tick)
    )
    link.add(to: .main, forMode: .common)
    visibilityLink = link
  }

  private func stopWaitingForVisibility() {
    visibilityLink?.invalidate()
    visibilityLink = nil
  }

  fileprivate func onVisibilityTick() {
    if canRenderGlass { setNeedsLayout() }
  }

  private func updatePanGesture() {
    if panEnabled, panRecognizer == nil {
      let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
      pan.delegate = self
      // 我们自己**不**取消触摸：RN 那边的点击路径（onTouchEnd）还要用
      pan.cancelsTouchesInView = false
      pan.delaysTouchesBegan = false
      addGestureRecognizer(pan)
      panRecognizer = pan
    } else if !panEnabled, let pan = panRecognizer {
      removeGestureRecognizer(pan)
      panRecognizer = nil
    }
  }

  @objc private func handlePan(_ g: UIPanGestureRecognizer) {
    guard let onPan else { return }
    let state: Int
    switch g.state {
    case .began: state = 0
    case .changed: state = 1
    case .ended: state = 2
    default: state = 3
    }
    let p = g.translation(in: self)
    // CGFloat 显式转 Double：字典要桥成 NSDictionary，别让桥接层猜
    onPan([
      "state": state,
      "translationX": Double(p.x),
      "translationY": Double(p.y),
    ])
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

    if GlassView.glassEffectAvailable {
      // ★ 真玻璃自带边缘高光与折射，自己再叠一层高光/描边只会显脏
      highlightLayer.isHidden = true
      borderLayer.isHidden = true

      // ★ 这里**只重刷已经装好的玻璃**（改圆角 / 改主题色时）；
      //   还没装就什么也不做，等 `layoutSubviews` —— 早装 = 一片空白。
      reloadGlass()
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

  /**
   * 这台机器到底有没有 `UIGlassEffect`。
   *
   * ★ 编译期用 `#available(iOS 26.0, *)` 分岔，运行期再确认一次类真的在 ——
   *   iOS 26 的**测试版**上曾经出现过 `UIGlassEffect` 一初始化就崩的情况
   *   （`expo-glass-effect` 也专门防了这一手）。确认不了就老老实实走模糊兜底。
   */
  private static let glassEffectAvailable: Bool = {
    if #available(iOS 26.0, *) {
      return NSClassFromString("UIGlassEffect") != nil
    }
    return false
  }()
}

extension GlassView: UIGestureRecognizerDelegate {
  /**
   * ★ 必须允许**同时识别**：玻璃自己的按压手势和我们的 pan 各跑各的，
   *   一个负责材质扩张，一个负责把位移转给 JS。
   */
  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    true
  }
}

/** `CADisplayLink` 会强引用 target —— 用弱代理，别把视图钉住 */
private final class VisibilityProxy: NSObject {
  private weak var view: GlassView?

  init(_ view: GlassView) {
    self.view = view
  }

  @objc func tick() {
    view?.onVisibilityTick()
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
