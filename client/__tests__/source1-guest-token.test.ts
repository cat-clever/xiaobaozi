/**
 * 源1 游客 token 的回归测试。
 *
 * ★ 这一条**静默失败过**：`init_v2` 会给游客下发一个 token，客户端没存，
 *   于是 `detail_v2` / `collection_v2` 一律回 `result: {}` —— 不报错、看着成功，
 *   表现只是"线路一条都取不到"。天际马甲因为构造时硬塞了 `TIANJI_TOKEN`
 *   恰好绕过这个 bug，反而把排查带偏了整整一轮。
 *
 * 所以这里锁死两件事：token 要存下来，而且**要真的进请求头**。
 */
import { describe, expect, it } from 'vitest';

import { Source1Client, applyUserInfo } from '../src/api/source1/client';
import { MAHAO } from '../src/api/source1/constants';
import { buildHeaders } from '../src/api/source1/crypto';

const CUR_TIME = 1700000000000;

describe('源1 · init 下发的游客 token', () => {
  it('游客客户端初始没有 token', () => {
    const client = new Source1Client(MAHAO.DIEYING);
    expect(client.token).toBe('');
  });

  it('★ init 下发的 token 必须被存下来', () => {
    const client = new Source1Client(MAHAO.DIEYING);
    applyUserInfo(client, { user_id: 139334446, token: 'guest-token-abc', nickname: '游客' });

    expect(client.token).toBe('guest-token-abc');
    expect(client.account.user_id).toBe(139334446);
  });

  it('★ 存下来的 token 必须真的进请求头（否则等于没存）', () => {
    const client = new Source1Client(MAHAO.DIEYING);
    applyUserInfo(client, { token: 'guest-token-abc' });

    const headers = buildHeaders(client.entry, client.deviceId, client.token, CUR_TIME);
    expect(headers.token).toBe('guest-token-abc');
  });

  it('user_info 没带 token 时不要清掉已有的（天际的老账号 token）', () => {
    const client = new Source1Client(MAHAO.TIANJI);
    const before = client.token;
    expect(before.length).toBeGreaterThan(0);

    applyUserInfo(client, { user_id: 1 });
    expect(client.token).toBe(before);
  });

  it('user_info 是空/非法时原样不动', () => {
    const client = new Source1Client(MAHAO.DIEYING);
    applyUserInfo(client, undefined);
    applyUserInfo(client, null);
    applyUserInfo(client, 'not an object');
    expect(client.token).toBe('');
    expect(client.account).toEqual({});
  });
});
