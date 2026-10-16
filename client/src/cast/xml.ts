/**
 * **从宽**的 XML 取值工具。
 *
 * ★★ 为什么不引 XML 解析库：电视上的 UPnP 实现**五花八门** ——
 *   命名空间前缀乱写（`s:` / `u:` / `m:` / 干脆没有）、属性顺序不固定、
 *   缺 `<?xml?>` 声明、自闭合标签大小写不一、编码声明撒谎。
 *   正经解析器遇到这些会**直接抛**，而我们要的是"能抠出值就继续"。
 *   （用户 2026-10-16 的硬要求：「最宽松校验，省的无法投屏在电视上」。）
 *
 * ★ 所以这里一律用**正则**，规则只有一条：**抠不出来就给空串，绝不抛异常**。
 *   所有函数都是纯函数，能在 vitest 里单测（见 `__tests__/cast.test.ts`）。
 */

/** 解 XML 实体。数字实体（`&#39;` / `&#x27;`）也解 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // ★ `&amp;` 必须最后解：先解的话 `&amp;lt;` 会被二次解成 `<`
    .replace(/&amp;/g, '&');
}

/** 标签名里可能有命名空间前缀（`dc:title` / `s:Envelope`），也可能没有 */
function tagPattern(tag: string): string {
  return `<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}\\s*>`;
}

/** 取**第一个**匹配标签的整块（含标签本身）。取不到回空串 */
export function firstBlock(xml: string, tag: string): string {
  const match = new RegExp(tagPattern(tag), 'i').exec(xml);
  return match ? match[0] : '';
}

/** 取**所有**匹配标签的整块 */
export function allBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(tagPattern(tag), 'gi');
  let match = re.exec(xml);
  while (match) {
    out.push(match[0]);
    // 防零宽匹配死循环
    if (re.lastIndex === match.index) re.lastIndex += 1;
    match = re.exec(xml);
  }
  return out;
}

/** 取**第一个**匹配标签的文本（去空白 + 解实体）。取不到回空串 */
export function tagText(xml: string, tag: string): string {
  const match = new RegExp(tagPattern(tag), 'i').exec(xml);
  if (!match) return '';
  return decodeEntities(stripTags(match[1])).trim();
}

/** 取标签块里某个属性的值（大小写不敏感、单双引号都认）。取不到回空串 */
export function attrOf(block: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const match = re.exec(block);
  if (!match) return '';
  return decodeEntities(match[2] ?? match[3] ?? '').trim();
}

/** 把标签块里的子标签剥掉，只留文本（`<dc:title>x</dc:title>` 用得着） */
export function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

/**
 * 解析一个 `Content-Range` 式的 `REL_TIME`（`00:01:23.456`）成秒。
 *
 * ★ 设备给的格式不统一：有的给毫秒、有的给 `0:0:0`、有的干脆回
 *   `NOT_IMPLEMENTED`。**解析不出来就回 null**，让 UI 显示"--:--"，
 *   不要回 0（回 0 会被当成"播到开头了"，进度条会乱跳）。
 */
export function parseRelTime(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/.exec(trimmed);
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const fraction = match[4] ? Number.parseFloat(`0.${match[4]}`) : 0;
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

/** 秒 -> `H:MM:SS`（DLNA 的 `Seek` 要这个格式） */
export function toRelTime(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
