/**
 * OTA 更新清单的解析与版本比较（纯逻辑，不碰网络 / 原生）。
 *
 * ★ 这里最要紧的一条：`0.2.10` 比 `0.2.9` 新 ——
 *   按字符串比会得出相反的结论，症状是"发完这一版以后再也不会提示更新"，
 *   而且安安静静、什么都不报。
 */
import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  formatSize,
  hasUpdate,
  parseManifest,
  shortDate,
} from '../src/update/manifest';

describe('版本比较', () => {
  it('★ 逐段按数字比，不是按字符串比', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1);
    expect(compareVersions('0.2.9', '0.2.10')).toBe(-1);
    expect(compareVersions('0.2.10', '0.2.10')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0', '0.9.9')).toBe(1);
  });

  it('缺段按 0 补：0.2 === 0.2.0', () => {
    expect(compareVersions('0.2', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.1', '0.2')).toBe(1);
  });

  it('脏数据不炸：非数字段当 0', () => {
    expect(compareVersions('0.2.x', '0.2.0')).toBe(0);
    expect(compareVersions('', '0.0.0')).toBe(0);
  });
});

describe('有没有新版本', () => {
  const manifest = parseManifest({
    version: '0.2.11',
    versionCode: 15,
    android: { url: 'https://example.com/a.apk', size: 55 * 1024 * 1024 },
    ios: { url: 'https://example.com/a.ipa', source: 'https://example.com/s.json' },
    page: 'https://example.com/page',
  });

  it('清单能解析出来', () => {
    expect(manifest).not.toBeNull();
    expect(manifest?.version).toBe('0.2.11');
    expect(manifest?.versionCode).toBe(15);
    expect(manifest?.notes).toEqual([]);
  });

  it('★ Android 认 versionCode（整数，不会错）', () => {
    // 版本号看着"更旧"，但 versionCode 更大 —— 依然要提示更新
    const m = { ...manifest!, version: '0.2.9', versionCode: 15 };
    expect(hasUpdate(m, { version: '0.2.10', versionCode: 14 }, 'android')).toBe(
      true,
    );
    expect(hasUpdate(m, { version: '0.2.10', versionCode: 15 }, 'android')).toBe(
      false,
    );
  });

  it('★ iOS 认版本号（没有 versionCode 这个概念）', () => {
    expect(
      hasUpdate(manifest!, { version: '0.2.10', versionCode: 0 }, 'ios'),
    ).toBe(true);
    expect(
      hasUpdate(manifest!, { version: '0.2.11', versionCode: 0 }, 'ios'),
    ).toBe(false);
    // 本机版本拿不到（空串）时不该提示更新
    expect(hasUpdate(manifest!, { version: '', versionCode: 0 }, 'ios')).toBe(
      true,
    );
  });
});

describe('清单解析', () => {
  it('版本号不合法就整份作废', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('nope')).toBeNull();
    expect(parseManifest({})).toBeNull();
    expect(parseManifest({ version: 'v0.2.11' })).toBeNull();
    expect(parseManifest({ version: 'latest' })).toBeNull();
  });

  it('缺的可选字段给安全默认值，不抛错', () => {
    const m = parseManifest({ version: '0.2.11' });
    expect(m).not.toBeNull();
    expect(m?.androidUrl).toBe('');
    expect(m?.androidSize).toBe(0);
    expect(m?.notes).toEqual([]);
    expect(m?.publishedAt).toBe('');
  });

  it('notes 里的空行被丢掉', () => {
    const m = parseManifest({
      version: '0.2.11',
      notes: ['fix: 修 Tab 栏', '  ', 42, 'feat: 加 OTA'],
    });
    expect(m?.notes).toEqual(['fix: 修 Tab 栏', 'feat: 加 OTA']);
  });
});

describe('展示用的格式化', () => {
  it('日期只留到天', () => {
    expect(shortDate('2026-10-16T05:46:22Z')).toBe('2026-10-16');
    expect(shortDate('')).toBe('');
  });

  it('体积', () => {
    expect(formatSize(55.21 * 1024 * 1024)).toBe('55.2 MB');
    expect(formatSize(820 * 1024)).toBe('820 KB');
    expect(formatSize(0)).toBe('');
  });
});
