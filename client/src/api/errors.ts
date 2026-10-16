/** 协议层统一的错误类型 —— 让 UI 能区分"重试就好"与"没救了" */

/** 上游返回了可识别的业务错误 */
export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 服务端回了明文错误提示（而非加密的 JSON 体）。
 * 文案通常是「系统出问题啦~请稍后再试」—— 属于**被挡了**，重试次数别多。
 */
export class ServerBusyError extends ApiError {
  constructor(message: string) {
    super(message);
    this.name = 'ServerBusyError';
  }
}

/** 自动降级链全试过了 —— 跟普通上游错误分开，UI 好单独提示 */
export class AllDownError extends ApiError {
  constructor(message: string) {
    super(message);
    this.name = 'AllDownError';
  }
}

/** 网络层错误（超时、DNS、连接失败） */
export class NetworkError extends ApiError {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}
