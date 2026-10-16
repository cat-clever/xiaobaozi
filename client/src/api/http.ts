/**
 * 统一的 HTTP 封装。
 *
 * 只依赖标准 `fetch`（RN 与 Node 18+ 都内置），不引第三方库。
 * 负责：超时、把响应体读成文本（协议层要自己解密，不能直接 .json()）。
 */
import { NetworkError } from './errors';

export interface HttpRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 发一次请求，超时抛 NetworkError。**不重试** —— 重试策略由调用方决定 */
export async function httpRequest(url: string, options: HttpRequest = {}): Promise<HttpResponse> {
  const { method = 'GET', headers = {}, body, timeoutMs = 15000 } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      // RN 上默认就会带 cookie/缓存，这里显式关掉缓存避免拿到陈旧线路
      cache: 'no-store',
    } as RequestInit);

    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('abort') || message.includes('Aborted')) {
      throw new NetworkError(`请求超时（${timeoutMs}ms）：${url}`);
    }
    throw new NetworkError(`请求失败：${message}`);
  } finally {
    clearTimeout(timer);
  }
}
