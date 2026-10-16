# -*- coding: utf-8 -*-
"""生成 SideStore Source JSON、更新清单（latest.json）与 Release 说明。

在 CI 里运行，读取环境变量 TAG / REPO，扫描 dist/ 下的产物。
"""
import glob
import json
import os
import re
import subprocess
from datetime import datetime, timezone

TAG = os.environ.get("TAG", "v0.0.0")
REPO = os.environ.get("REPO", "owner/repo")
VERSION = TAG.lstrip("v")


def android_version_code():
    """从 build.gradle 里读 versionCode。

    ★ 不猜、不从 tag 推：清单里那个整数必须与 APK 里真正的一致，
      否则 App 会拿它比大小 —— 差一个数就是"永远提示更新"或"永远不提示"。
    """
    path = "client/android/app/build.gradle"
    with open(path, encoding="utf-8") as f:
        m = re.search(r"versionCode\s+(\d+)", f.read())
    if not m:
        raise SystemExit(f"读不到 {path} 里的 versionCode")
    return int(m.group(1))


def changelog():
    """上一版到这一版之间的提交标题 —— 就是"这版改了什么"。

    ★ 需要**完整的 git 历史**（release job 的 checkout 要 `fetch-depth: 0`），
      否则 `git describe` 找不到上一个 tag，只能退化成"最近几条提交"。
    ★ 只去掉 chore/docs 这类对用户没意义的提交，其余原样保留。
    """
    rng = ["-n", "12"]
    try:
        prev = subprocess.run(
            ["git", "describe", "--abbrev=0", "--tags", f"{TAG}^"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        if prev:
            rng = [f"{prev}..{TAG}"]
    except Exception as e:  # noqa: BLE001 —— 找不到上一个 tag 不算错
        print(f"拿不到上一个 tag（{e}），退化成本 tag 之前的提交")

    out = subprocess.run(
        ["git", "log", "--pretty=format:%s", *rng],
        capture_output=True, text=True, check=True,
    ).stdout

    lines = []
    for line in out.splitlines():
        line = line.strip()
        if not line or line.startswith(("chore:", "docs:", "Merge ")):
            continue
        lines.append(line)
    return lines


CHANGES = changelog()

ipas = sorted(glob.glob("dist/*.ipa"))
apks = sorted(glob.glob("dist/*.apk"))
if not ipas:
    raise SystemExit("没有找到 IPA 产物")
if not apks:
    raise SystemExit("没有找到 APK 产物")

ipa = ipas[0]
ipa_name = os.path.basename(ipa)
apk = apks[0]
apk_name = os.path.basename(apk)

release_base = f"https://github.com/{REPO}/releases/download/{TAG}"
page_url = f"https://github.com/{REPO}/releases/tag/{TAG}"
# ★ 这两个地址是 **latest** 语义（永远指向最新一次 release 的资产），
#   App 里的更新检查、SideStore 更新源都读它们，所以 JS 侧不用跟着版本号改。
latest_base = f"https://github.com/{REPO}/releases/latest/download"
published_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# SideStore 的 Source JSON（见项目文档 §9.2.7）
source = {
    "name": "小包子影视",
    "identifier": "com.xiaobaozi.source",
    "apps": [
        {
            "name": "小包子影视",
            "bundleIdentifier": "org.reactjs.native.example.BaoziVideo",
            "developerName": "xiaobaozi",
            "subtitle": "端内双源直连的双端流媒体客户端",
            "localizedDescription": (
                "不经过任何中转服务器：请求签名、响应解密、线路解析与 CDN 取流"
                "全部在设备上完成。"
            ),
            "version": VERSION,
            "versionDate": published_at,
            "downloadURL": f"{release_base}/{ipa_name}",
            "size": os.path.getsize(ipa),
            "minOSVersion": "15.1",
        }
    ],
}

os.makedirs("source", exist_ok=True)
with open("source/xiaobaozi.json", "w", encoding="utf-8") as f:
    json.dump(source, f, ensure_ascii=False, indent=2)
print("Source JSON 已生成：")
print(json.dumps(source, ensure_ascii=False, indent=2))

# 端内更新清单。App 的「设置 → 检查更新」读的就是它（见 src/update/updater.ts）
manifest = {
    "version": VERSION,
    "versionCode": android_version_code(),
    "publishedAt": published_at,
    "notes": CHANGES,
    "android": {
        "url": f"{release_base}/{apk_name}",
        "size": os.path.getsize(apk),
    },
    "ios": {
        "url": f"{release_base}/{ipa_name}",
        "size": os.path.getsize(ipa),
        "source": f"{latest_base}/xiaobaozi.json",
    },
    "page": page_url,
}
with open("source/latest.json", "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
print("更新清单已生成：")
print(json.dumps(manifest, ensure_ascii=False, indent=2))

changes_md = "\n".join(f"- {line}" for line in CHANGES) or "- （无）"

notes = f"""## 小包子影视 {TAG}

端内双源直连的双端流媒体客户端。**不经过任何中转服务器** —— 请求签名、响应解密、
线路解析与 CDN 取流全部在设备上完成。

### 本版改动

{changes_md}

### 产物

| 文件 | 说明 |
| :--- | :--- |
| `{apk_name}` | Android 安装包，**固定签名**，升级安装无需先卸载 |
| `{ipa_name}` | iOS **未签名** IPA，需用 SideStore 等工具以自己的 Apple ID 签名 |
| `latest.json` | 端内「检查更新」读的清单（Android 可直接下载安装） |

### iOS 安装提示

免费 Apple ID 的证书 **7 天过期**，到期后 App 无法启动、必须刷新。
推荐用 [SideStore](https://sidestore.io/) 在设备本机自动续签，无需常连电脑。

### 已知风险

本项目依赖上游内容源，协议随时可能变更。上游一变，App 可能暂时无法播放，
需要重新适配才能恢复 —— 这是这类客户端的固有风险，不是偶发故障。
"""

with open("RELEASE_NOTES.md", "w", encoding="utf-8") as f:
    f.write(notes)
print("Release 说明已生成")

