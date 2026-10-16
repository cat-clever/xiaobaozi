import Foundation
import React

/**
 * 更新（iOS 侧）。
 *
 * ★★ iOS **故意不做**端内下载安装：我们的 IPA 是**未签名**的，
 *   系统不允许 App 自己装自己（越狱 / 企业证书 / TestFlight 都不适用），
 *   没有合法的自升级路径。所以这里只提供"本机版本号"这一个能力 ——
 *   下载安装那套是 Android 专属的（`UpdaterModule.kt`）。
 *   iOS 上的"升级"由 JS 侧完成：打开发布页，或用 SideStore 更新源刷新。
 *
 * ★ 版本号取 `CFBundleShortVersionString`，也就是工程里的 `MARKETING_VERSION`。
 *   它**必须与 tag 一致** —— SideStore 拿源里的 `version` 跟已装 App 的版本比大小，
 *   如果 App 自称 `1.0`、源里是 `0.2.x`，它会认为"装的比源里的还新"，
 *   于是永远不提示更新。发版时记得三处一起改：
 *     `android/app/build.gradle`(versionName) / `MARKETING_VERSION` / tag。
 */
@objc(Updater)
final class Updater: NSObject {

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func getVersion(_ resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
    let info = Bundle.main.infoDictionary ?? [:]
    let versionName = info["CFBundleShortVersionString"] as? String ?? ""
    let build = Int(info["CFBundleVersion"] as? String ?? "") ?? 0

    resolve([
      "versionName": versionName,
      "versionCode": build,
      "packageId": Bundle.main.bundleIdentifier ?? "",
    ])
  }
}
