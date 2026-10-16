/**
 * 更新清单（CI 生成的 `latest.json`）的**纯逻辑**。
 *
 * 只做两件事：把 JSON 收窄成结构体、比版本号。
 * 网络与原生都在 `updater.ts` 里 —— 拆开是为了这两块能单测。
 */

/** 一份可以拿来判断"要不要提示升级"的清单 */
export interface UpdateManifest {
  /** 版本号（跟 tag 一致，如 `0.2.11`）。iOS 用它比大小 */
  version: string;
  /** Android 的 `versionCode`。Android 用它比大小（整数比版本字符串可靠） */
  versionCode: number;
  /** 发布时间（ISO8601，如 `2026-10-16T05:46:22Z`） */
  publishedAt: string;
  /** 这版改了什么（CI 从 git 提交标题生成，一条一行） */
  notes: string[];
  /** APK 直链 */
  androidUrl: string;
  /** APK 字节数（0 = 未知） */
  androidSize: number;
  /** 未签名 IPA 直链（iOS 装不了，只用来展示 / 复制） */
  iosUrl: string;
  /** 发布页 */
  pageUrl: string;
  /** SideStore 更新源 JSON —— iOS 上真正能"升级"的路子 */
  iosSourceUrl: string;
}

/** 本机装的是哪一版 */
export interface CurrentVersion {
  version: string;
  /** Android 的 versionCode；iOS 没有这个概念（给 0） */
  versionCode: number;
}

const asString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const asInt = (value: unknown): number => {
  const n =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * 解析 CI 生成的清单。
 *
 * ★ 宁可不提示，也不能提示错：版本号不是 `数字.数字…` 就直接判清单无效。
 *   宁可让用户看到"检查更新失败"，也不要把他领到一个装不上的东西上去。
 */
export function parseManifest(raw: unknown): UpdateManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const version = asString(o.version);
  if (!/^\d+(?:\.\d+)*$/.test(version)) return null;

  const android = (o.android ?? {}) as Record<string, unknown>;
  const ios = (o.ios ?? {}) as Record<string, unknown>;

  return {
    version,
    versionCode: asInt(o.versionCode),
    publishedAt: asString(o.publishedAt),
    notes: Array.isArray(o.notes)
      ? o.notes.map(asString).filter(line => line.length > 0)
      : [],
    androidUrl: asString(android.url),
    androidSize: asInt(android.size),
    iosUrl: asString(ios.url),
    pageUrl: asString(o.page),
    iosSourceUrl: asString(ios.source),
  };
}

/**
 * 比版本号，**逐段比数字**。
 *
 * ★ `0.2.10` vs `0.2.9`：按字符串比会得出 `0.2.10 < 0.2.9`（`'1' < '9'`），
 *   于是发完这一版以后**再也不会**提示更新 —— 必须拆开按数字比。
 *
 * 返回 `> 0` 表示 a 更新，`< 0` 表示 b 更新，`0` 表示一样。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = asInt(pa[i]);
    const nb = asInt(pb[i]);
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

/**
 * 清单里的版本比本机新吗。
 *
 * ★ Android 用 `versionCode` 比（整数，绝对不会错）；
 *   ★ iOS 没有 versionCode（`CFBundleVersion` 不参与版本比较），用版本号比。
 */
export function hasUpdate(
  manifest: UpdateManifest,
  current: CurrentVersion,
  platform: string,
): boolean {
  if (
    platform === 'android' &&
    manifest.versionCode > 0 &&
    current.versionCode > 0
  ) {
    return manifest.versionCode > current.versionCode;
  }
  return compareVersions(manifest.version, current.version) > 0;
}

/**
 * 收下原生报的"本机装的是哪一版"。
 *
 * ★★ 原生两端都把**版本名**放在 `versionName` 里
 *   （Android = `PackageInfo.versionName`，iOS = `CFBundleShortVersionString`），
 *   而 JS 一开始只认 `version` —— iOS 上就拿到了**空串**，而 iOS 是
 *   **按版本号字符串比**的：`'0.2.11' > ''` 恒成立，于是**永远**提示"发现新版本"，
 *   界面上「当前版本」也成了空（只剩个 `(15)` 构建号）。
 *   Android 侥幸没事 —— 它比的是 `versionCode`。所以这里两个键名都认。
 * ★ 名字对不上就**返回空串**，由 `canCompare` 判成"问不到版本号"；
 *   绝不编一个版本号出来（编错了比不显示更糟）。
 */
export function normalizeCurrentVersion(raw: unknown): CurrentVersion {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    version: asString(o.version) || asString(o.versionName),
    versionCode: asInt(o.versionCode),
  };
}

/**
 * 本机版本信息**够不够**判断要不要升级。
 *
 * ★ 比的是哪个字段取决于平台（见 `hasUpdate`）：Android 优先 `versionCode`，
 *   其余情况全靠版本号字符串。缺了对应的那个就**判不了**。
 * ★ 判不了时必须走"检查失败"，**不能**当成"有新版本" ——
 *   后者会让用户每次开 App 都看到一个假的更新提示（iOS 上那个 bug 就是这表象）。
 */
export function canCompare(
  manifest: UpdateManifest,
  current: CurrentVersion,
  platform: string,
): boolean {
  if (
    platform === 'android' &&
    manifest.versionCode > 0 &&
    current.versionCode > 0
  ) {
    return true;
  }
  return /^\d+(?:\.\d+)*$/.test(current.version);
}

/** `2026-10-16T05:46:22Z` -> `2026-10-16`；认不出来就原样返回（可能是空串） */
export function shortDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso.trim());
  return m ? m[1] : iso.trim();
}

/** 字节数 -> `55.2 MB` / `800 KB`；0 或负数给空串 */
export function formatSize(bytes: number): string {
  if (!(bytes > 0)) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
