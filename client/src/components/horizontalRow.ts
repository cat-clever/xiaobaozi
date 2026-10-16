/**
 * 手指是不是正按在「横向滚动的行」上。
 *
 * ★ 内容区要支持横滑切 Tab，但**板块上**的横滑是留给板块自己滚的 ——
 *   分页器得能区分这两种情况，所以在板块上按下时打个标记。
 *
 * 用模块级变量而不是 React state：PanResponder 的手势判断回调是**同步**的，
 * 读 state 会拿到上一帧的值，判断就错了。
 *
 * 用计数而不是布尔：多指同时按在板块上时，抬起一根手指不该把标记清掉。
 */
let depth = 0;

export const enterHorizontalRow = (): void => {
  depth += 1;
};

export const leaveHorizontalRow = (): void => {
  depth = Math.max(0, depth - 1);
};

export const isOnHorizontalRow = (): boolean => depth > 0;
