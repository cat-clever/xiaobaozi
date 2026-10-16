/**
 * 选集标题。
 *
 * ★ 规则就一条：**有名字就用名字，没有就用数字**。
 *
 *   实测（2026-10-15）上游给的东西很杂：
 *     - 源1 常常只给一个裸数字（`collection: "1"`）—— 没名字
 *     - 源2 有的剧整条**没有 `title` 字段**（如《心动制造所》），
 *       有的又是空串，有的给真名字（如《背着善宰跑》的「重回十九岁」）
 *
 *   所以不能一刀切：真有名字的（综艺的「第1期花絮特辑：沙滩小黑脚」这种）
 *   必须原样保留，只有"没名字"时才退化成数字。
 */
export function episodeTitle(raw: unknown, index: number): string {
  const text = String(raw ?? '').trim();
  if (!text) return String(index + 1);

  // 纯数字（"1" / "01" / "10"）当成没给名字，顺便去掉前导零
  if (/^\d+$/.test(text)) return String(Number(text));

  return text;
}
