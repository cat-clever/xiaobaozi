# 小包子

端内双源直连的双端流媒体客户端（Android / iOS）。

## 架构

完整设计见项目内部的《项目开发说明文档》（**不随仓库分发**）。要点：

- **无服务端**：协议在端内复刻，`参考/` 下的两个文件是权威参考实现
- **本地媒体服务**：设备内 HTTP 服务，承担 UA/Badci 注入、m3u8 重写、`wsSecret` 现算、Range 透传
- **投屏**：DLNA / AirPlay，直投优先，转发兜底复用同一个媒体服务
- **液态玻璃 UI**：iOS 26 / 27 Liquid Glass + Android RenderEffect 模糊

## 构建

本地构建需要 Xcode（iOS）或 JDK 17 + Android SDK（Android）。

本项目主要通过 **GitHub Actions** 构建，推送 tag 即可产出：

- `app-release.apk`（Android）
- `BaoziVideo-unsigned.ipa`（iOS，未签名，供 SideStore 等工具自行签名）

详见 [`.github/workflows/`](./.github/workflows/)。

### iOS 侧载

iOS 包为**未签名 IPA**——每个用户需用自己的 Apple ID 签名。免费账号证书 **7 天过期**，到期后 App 无法启动，必须刷新。推荐使用 [SideStore](https://sidestore.io/) 在设备本机自动续签。详见项目文档 §9.2。

## 许可

[GPLv3](./LICENSE)。
